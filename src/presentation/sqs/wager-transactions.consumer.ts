import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { ApplicationError } from '../../application/errors';
import { canonicalJson, sha256Hex } from '../../application/payload-hash';
import { SubmitWagerTransactionUseCase } from '../../application/submit-wager-transaction.use-case';
import { WagerTransactionKind } from '../../domain/wager/wager-transaction';
import { DomainError, ValidationError } from '../../domain/shared/domain-error';
import { AppConfig } from '../../infrastructure/config';
import { QueueUrls } from '../../infrastructure/messaging/sqs';
import { logger, withLogContext } from '../../infrastructure/observability/logger';
import { metrics } from '../../infrastructure/observability/metrics';
import { parse, wagerMessageSchema } from '../contracts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Disposition =
  | { action: 'ack'; outcome: string }
  | { action: 'retry'; reason: string }
  | { action: 'dlq'; reason: string; detail: string };

/**
 * Consumidor de wager-transactions.fifo.
 *
 *  - Reusa o mesmo caso de uso da API HTTP.
 *  - Deduplica pelo inbox persistente (consumerName, messageId), gravado na
 *    mesma transação SQL do processamento.
 *  - Ack (DeleteMessage) somente depois do commit.
 *  - Negócio (rejeição, conflito de idempotência, wallet inexistente): terminal, ack.
 *  - Transitório (banco fora, timeout de lock): não faz ack; devolve com
 *    backoff exponencial via ChangeMessageVisibility.
 *  - Permanente (mensagem malformada, tentativas esgotadas): DLQ.
 *  - SIGTERM: para de buscar, termina a mensagem em andamento e devolve a
 *    visibilidade das que ainda não começaram.
 */
export class WagerTransactionsConsumer {
  private running = false;
  private loops: Promise<void>[] = [];

  constructor(
    private readonly useCase: SubmitWagerTransactionUseCase,
    private readonly sqs: SQSClient,
    private readonly queues: QueueUrls,
    private readonly config: AppConfig,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    for (let i = 0; i < this.config.consumer.concurrency; i++) {
      this.loops.push(this.loop(i));
    }
    logger.info({ concurrency: this.config.consumer.concurrency }, 'consumidor SQS iniciado');
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    await Promise.all(this.loops);
    this.loops = [];
    logger.info('consumidor SQS parado');
  }

  private async loop(worker: number): Promise<void> {
    const queueUrl = await this.resolveQueueUrl();
    let failures = 0;
    while (this.running) {
      try {
        const res = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: this.config.consumer.waitTimeSec,
            VisibilityTimeout: this.config.consumer.visibilityTimeoutSec,
            MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
            MessageAttributeNames: ['All'],
          }),
        );
        failures = 0;
        const messages = res.Messages ?? [];
        for (let i = 0; i < messages.length; i++) {
          if (!this.running) {
            await this.release(queueUrl, messages.slice(i));
            break;
          }
          await this.handle(queueUrl, messages[i]!);
        }
      } catch (err) {
        failures++;
        logger.error({ worker, err: (err as Error).message }, 'falha ao receber mensagens do SQS');
        await sleep(Math.min(500 * 2 ** failures, 15_000));
      }
    }
  }

  private async resolveQueueUrl(): Promise<string> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.queues.get(this.config.queues.wagerTransactions);
      } catch (err) {
        if (!this.running) throw err;
        logger.warn({ attempt, err: (err as Error).message }, 'fila indisponível, tentando de novo');
        await sleep(Math.min(500 * 2 ** attempt, 15_000));
      }
    }
  }

  /** Processa uma mensagem. Público para os testes. */
  async handle(queueUrl: string, message: Message): Promise<Disposition> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    const correlationId =
      message.MessageAttributes?.correlationId?.StringValue ?? message.MessageId ?? 'unknown';

    return withLogContext({ correlationId, messageId: message.MessageId }, async () => {
      const started = performance.now();
      const disposition = await this.process(message, correlationId);

      if (disposition.action === 'retry' && receiveCount >= this.config.consumer.maxAttempts) {
        await this.toDlq(queueUrl, message, 'max-attempts', disposition.reason);
        metrics.sqsMessages.inc({ outcome: 'dlq' });
        return { action: 'dlq', reason: 'max-attempts', detail: disposition.reason } as Disposition;
      }

      switch (disposition.action) {
        case 'ack':
          if (this.config.faultInjection === 'crash-after-commit-before-ack') {
            logger.warn('FAULT_INJECTION: matando o processo depois do commit e antes do ack');
            process.kill(process.pid, 'SIGKILL');
            await sleep(10_000);
          }
          await this.ack(queueUrl, message);
          metrics.sqsMessages.inc({ outcome: disposition.outcome });
          break;
        case 'retry': {
          const delay = Math.min(this.config.consumer.retryBaseDelaySec * 2 ** (receiveCount - 1), 300);
          metrics.retries.inc({ operation: 'sqs-message', reason: disposition.reason });
          metrics.sqsMessages.inc({ outcome: 'retry' });
          logger.warn({ receiveCount, retryInSec: delay, reason: disposition.reason }, 'mensagem devolvida para nova tentativa');
          await this.changeVisibility(queueUrl, message, delay);
          break;
        }
        case 'dlq':
          await this.toDlq(queueUrl, message, disposition.reason, disposition.detail);
          metrics.sqsMessages.inc({ outcome: 'dlq' });
          break;
      }
      metrics.processingLatency.observe({ source: 'sqs' }, (performance.now() - started) / 1000);
      return disposition;
    });
  }

  private async process(message: Message, correlationId: string): Promise<Disposition> {
    let parsed;
    try {
      parsed = parse(wagerMessageSchema, JSON.parse(message.Body ?? ''));
    } catch (err) {
      return { action: 'dlq', reason: 'invalid-message', detail: (err as Error).message };
    }

    const { data } = parsed;
    try {
      const result = await withLogContext({ messageId: parsed.messageId, providerId: data.providerId, walletId: data.walletId }, () =>
        this.useCase.execute(
          { ...data, kind: data.kind as WagerTransactionKind },
          {
            source: 'sqs',
            correlationId,
            causationId: parsed.messageId,
            inbox: {
              consumerName: this.config.consumer.name,
              messageId: parsed.messageId,
              payloadHash: sha256Hex(canonicalJson(parsed)),
            },
          },
        ),
      );
      logger.info(
        { transactionId: result.transactionId, status: result.status, replay: result.idempotentReplay },
        result.duplicateMessage ? 'mensagem duplicada (inbox)' : 'mensagem processada',
      );
      return { action: 'ack', outcome: result.duplicateMessage ? 'duplicate' : result.status.toLowerCase() };
    } catch (err) {
      return this.classify(err);
    }
  }

  private classify(err: unknown): Disposition {
    if (err instanceof ValidationError) {
      return { action: 'dlq', reason: 'invalid-payload', detail: err.message };
    }
    if (err instanceof ApplicationError) {
      switch (err.kind) {
        case 'validation':
          return { action: 'dlq', reason: 'invalid-payload', detail: err.message };
        case 'conflict':
        case 'business':
        case 'not-found':
          logger.warn({ code: err.code, err: err.message }, 'mensagem encerrada por regra de negócio');
          return { action: 'ack', outcome: `business-${err.code.toLowerCase()}` };
        case 'transient':
          return { action: 'retry', reason: err.code.toLowerCase() };
      }
    }
    if (err instanceof DomainError) {
      // Erro de domínio inesperado aqui é bug (ex.: transição inválida). Não adianta repetir.
      logger.error({ code: err.code, err: err.message }, 'erro de domínio inesperado');
      return { action: 'dlq', reason: 'domain-error', detail: err.message };
    }
    logger.error({ err: (err as Error)?.message }, 'erro inesperado ao processar mensagem');
    return { action: 'retry', reason: 'unexpected-error' };
  }

  private async ack(queueUrl: string, message: Message): Promise<void> {
    try {
      await this.sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
    } catch (err) {
      // O commit já aconteceu; a redelivery será absorvida pelo inbox.
      logger.warn({ err: (err as Error).message }, 'falha no ack, a mensagem voltará e será deduplicada');
    }
  }

  private async changeVisibility(queueUrl: string, message: Message, seconds: number): Promise<void> {
    try {
      await this.sqs.send(
        new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: seconds }),
      );
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'falha ao ajustar visibilidade; a mensagem volta no timeout padrão');
    }
  }

  private async release(queueUrl: string, messages: Message[]): Promise<void> {
    await Promise.all(messages.map((m) => this.changeVisibility(queueUrl, m, 0)));
    logger.info({ count: messages.length }, 'mensagens não iniciadas devolvidas à fila no shutdown');
  }

  private async toDlq(queueUrl: string, message: Message, reason: string, detail: string): Promise<void> {
    const dlqUrl = await this.queues.get(this.config.queues.wagerTransactionsDlq);
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: dlqUrl,
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'dlq',
        MessageDeduplicationId: message.MessageId,
        MessageAttributes: {
          failureReason: { DataType: 'String', StringValue: reason },
          failureDetail: { DataType: 'String', StringValue: detail.slice(0, 1000) || reason },
        },
      }),
    );
    metrics.dlqMessages.inc({ reason });
    logger.error({ reason }, 'mensagem enviada para a DLQ');
    // Só remove da fila principal depois que a DLQ aceitou. Se cair entre os dois, a DLQ pode ter duplicata (inofensivo).
    await this.ack(queueUrl, message);
  }
}
