import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { AppConfig } from '../../infrastructure/config';
import { QueueUrls } from '../../infrastructure/messaging/sqs';

type Check = { status: 'ok' | 'down'; latencyMs: number; error?: string };

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms))]);
}

/** Readiness: PostgreSQL e SQS alcançáveis. Liveness não depende de nada externo. */
export class HealthService {
  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SQSClient,
    private readonly queues: QueueUrls,
    private readonly config: AppConfig,
  ) {}

  async readiness(): Promise<{ status: 'ok' | 'down'; checks: { postgres: Check; sqs: Check } }> {
    const [postgres, sqs] = await Promise.all([
      this.check(() => this.orm.em.fork().execute('select 1')),
      this.check(async () => {
        const url = await this.queues.get(this.config.queues.wagerTransactions);
        await this.sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['QueueArn'] }));
      }),
    ]);
    const status = postgres.status === 'ok' && sqs.status === 'ok' ? 'ok' : 'down';
    return { status, checks: { postgres, sqs } };
  }

  private async check(fn: () => Promise<unknown>): Promise<Check> {
    const started = performance.now();
    try {
      await withTimeout(fn(), 2_000);
      return { status: 'ok', latencyMs: Math.round(performance.now() - started) };
    } catch (err) {
      return { status: 'down', latencyMs: Math.round(performance.now() - started), error: (err as Error).message };
    }
  }
}
