import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { Clock, UnitOfWork } from '../../application/ports';
import { AppConfig } from '../config';
import { logger, withLogContext } from '../observability/logger';
import { metrics } from '../observability/metrics';
import { PollingWorker } from '../workers/polling-worker';
import { QueueUrls } from './sqs';

/**
 * Publica eventos do outbox no SQS (wagering-events.fifo).
 *
 * Garantias:
 *  - nada é publicado antes do commit: o evento só existe no outbox depois dele;
 *  - vários publishers: cada um reivindica um lote com FOR UPDATE SKIP LOCKED +
 *    lease; lotes são disjuntos enquanto o lease vale;
 *  - publisher morre depois de publicar e antes de marcar: o lease expira e outro
 *    publica de novo (at-least-once). A duplicata é segura: MessageDeduplicationId
 *    = eventId deduplica no broker por 5 min e o consumidor deduplica por eventId.
 */
export class OutboxPublisher extends PollingWorker {
  protected readonly name = 'outbox-publisher';
  protected readonly intervalMs: number;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly sqs: SQSClient,
    private readonly queues: QueueUrls,
    private readonly config: AppConfig,
    private readonly clock: Clock,
  ) {
    super();
    this.intervalMs = config.outbox.pollMs;
  }

  protected async tick(): Promise<boolean> {
    const published = await this.publishBatch();
    await this.updateLagMetrics();
    return published >= this.config.outbox.batchSize;
  }

  /** Uma rodada de publicação. Público para os testes de publishers concorrentes. */
  async publishBatch(owner = this.config.instanceId): Promise<number> {
    const { batchSize, leaseMs, retryBaseMs, retryMaxMs } = this.config.outbox;
    const claimed = await this.uow.run((r) => r.outbox.claimDue(owner, batchSize, leaseMs, this.clock.now()));
    if (claimed.length === 0) return 0;

    let queueUrl: string;
    try {
      queueUrl = await this.queues.get(this.config.queues.events);
    } catch (err) {
      // SQS indisponível: devolve o lote com backoff em vez de esperar o lease expirar.
      metrics.outboxPublishFailures.inc(claimed.length);
      logger.warn({ err: (err as Error).message, count: claimed.length }, 'fila de eventos indisponível, lote reagendado');
      for (const message of claimed) {
        message.scheduleRetry(this.clock.now(), { baseDelayMs: retryBaseMs, maxDelayMs: retryMaxMs });
        await this.uow.read.outbox.scheduleRetry(message, owner);
      }
      return 0;
    }
    const blockedPartitions = new Set<string>();
    let published = 0;

    for (const message of claimed) {
      await withLogContext({ correlationId: String(message.payload.correlationId ?? '') }, async () => {
        // Se um evento da wallet falhou neste lote, os seguintes dela esperam (preserva a ordem).
        if (blockedPartitions.has(message.partitionKey)) {
          message.scheduleRetry(this.clock.now(), { baseDelayMs: retryBaseMs, maxDelayMs: retryMaxMs });
          await this.uow.read.outbox.scheduleRetry(message, owner);
          return;
        }
        try {
          await this.sqs.send(
            new SendMessageCommand({
              QueueUrl: queueUrl,
              MessageBody: JSON.stringify(message.payload),
              MessageGroupId: message.partitionKey,
              MessageDeduplicationId: message.eventId,
              MessageAttributes: {
                eventType: { DataType: 'String', StringValue: message.eventType },
                eventId: { DataType: 'String', StringValue: message.eventId },
              },
            }),
          );
          message.markPublished(this.clock.now());
          const marked = await this.uow.read.outbox.markPublished(message, owner);
          if (!marked) {
            // Lease expirou e outro publisher assumiu: publicação duplicada, segura por eventId.
            logger.warn({ outboxId: message.id }, 'lease do outbox perdido durante a publicação');
          }
          metrics.outboxPublished.inc({ event_type: message.eventType });
          published++;
        } catch (err) {
          blockedPartitions.add(message.partitionKey);
          metrics.outboxPublishFailures.inc();
          message.scheduleRetry(this.clock.now(), { baseDelayMs: retryBaseMs, maxDelayMs: retryMaxMs });
          await this.uow.read.outbox.scheduleRetry(message, owner).catch(() => undefined);
          logger.warn(
            { outboxId: message.id, attempts: message.attempts, err: (err as Error).message },
            'falha ao publicar evento, nova tentativa agendada',
          );
        }
      });
    }
    return published;
  }

  private async updateLagMetrics(): Promise<void> {
    const stats = await this.uow.read.outbox.stats(this.clock.now());
    metrics.outboxPending.set(stats.pending);
    metrics.outboxLag.set(stats.oldestPendingAgeSeconds);
  }
}
