import { hostname } from 'node:os';

const bool = (v: string | undefined, def: boolean) => (v === undefined ? def : v === 'true' || v === '1');
const int = (v: string | undefined, def: number) => (v === undefined || v === '' ? def : Number.parseInt(v, 10));

export interface AppConfig {
  instanceId: string;
  port: number;
  databaseUrl: string;
  dbPoolMax: number;
  lockTimeoutMs: number;
  aws: { endpoint: string; region: string; accessKeyId: string; secretAccessKey: string };
  queues: { wagerTransactions: string; wagerTransactionsDlq: string; events: string };
  consumer: {
    enabled: boolean;
    name: string;
    concurrency: number;
    maxAttempts: number;
    visibilityTimeoutSec: number;
    waitTimeSec: number;
    retryBaseDelaySec: number;
  };
  outbox: { enabled: boolean; batchSize: number; leaseMs: number; pollMs: number; retryBaseMs: number; retryMaxMs: number };
  pendingReferences: { enabled: boolean; pollMs: number; batchSize: number; baseDelayMs: number; maxDelayMs: number; maxAttempts: number };
  shutdownTimeoutMs: number;
  /** Somente testes: simula queda do processo em pontos críticos. */
  faultInjection?: 'crash-after-commit-before-ack';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    instanceId: env.INSTANCE_ID ?? `${hostname()}-${process.pid}`,
    port: int(env.PORT, 3000),
    databaseUrl: env.DATABASE_URL ?? 'postgres://wagering:wagering@localhost:5440/wagering',
    dbPoolMax: int(env.DB_POOL_MAX, 10),
    lockTimeoutMs: int(env.DB_LOCK_TIMEOUT_MS, 5_000),
    aws: {
      endpoint: env.AWS_ENDPOINT_URL ?? 'http://localhost:4570',
      region: env.AWS_REGION ?? 'us-east-1',
      accessKeyId: env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
    queues: {
      wagerTransactions: env.SQS_WAGER_QUEUE ?? 'wager-transactions.fifo',
      wagerTransactionsDlq: env.SQS_WAGER_DLQ ?? 'wager-transactions-dlq.fifo',
      events: env.SQS_EVENTS_QUEUE ?? 'wagering-events.fifo',
    },
    consumer: {
      enabled: bool(env.SQS_CONSUMER_ENABLED, true),
      name: env.SQS_CONSUMER_NAME ?? 'wager-transactions-consumer',
      concurrency: int(env.SQS_CONSUMER_CONCURRENCY, 4),
      maxAttempts: int(env.SQS_MAX_ATTEMPTS, 5),
      visibilityTimeoutSec: int(env.SQS_VISIBILITY_TIMEOUT_SEC, 30),
      waitTimeSec: int(env.SQS_WAIT_TIME_SEC, 10),
      retryBaseDelaySec: int(env.SQS_RETRY_BASE_DELAY_SEC, 2),
    },
    outbox: {
      enabled: bool(env.OUTBOX_PUBLISHER_ENABLED, true),
      batchSize: int(env.OUTBOX_BATCH_SIZE, 50),
      leaseMs: int(env.OUTBOX_LEASE_MS, 30_000),
      pollMs: int(env.OUTBOX_POLL_MS, 500),
      retryBaseMs: int(env.OUTBOX_RETRY_BASE_MS, 1_000),
      retryMaxMs: int(env.OUTBOX_RETRY_MAX_MS, 60_000),
    },
    pendingReferences: {
      enabled: bool(env.PENDING_REFERENCE_WORKER_ENABLED, true),
      pollMs: int(env.PENDING_REFERENCE_POLL_MS, 1_000),
      batchSize: int(env.PENDING_REFERENCE_BATCH_SIZE, 50),
      baseDelayMs: int(env.PENDING_REFERENCE_BASE_DELAY_MS, 2_000),
      maxDelayMs: int(env.PENDING_REFERENCE_MAX_DELAY_MS, 120_000),
      maxAttempts: int(env.PENDING_REFERENCE_MAX_ATTEMPTS, 10),
    },
    shutdownTimeoutMs: int(env.SHUTDOWN_TIMEOUT_MS, 20_000),
    faultInjection: env.FAULT_INJECTION === 'crash-after-commit-before-ack' ? 'crash-after-commit-before-ack' : undefined,
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');
