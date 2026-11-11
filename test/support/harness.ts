import 'reflect-metadata';
import { CreateQueueCommand, DeleteQueueCommand, GetQueueAttributesCommand, PurgeQueueCommand, ReceiveMessageCommand, DeleteMessageBatchCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { INestApplication } from '@nestjs/common';
import { SQL, type Subprocess } from 'bun';
import { randomUUID } from 'node:crypto';
import { AppConfig, loadConfig } from '../../src/infrastructure/config';
import { migrate } from '../../src/infrastructure/persistence/migrate';
import { bootstrap } from '../../src/main';

/**
 * Infraestrutura real para os testes de integração: PostgreSQL e LocalStack
 * do docker-compose (`bun run infra:up`). Nada de mock de banco ou fila.
 */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://wagering:wagering@localhost:5440/wagering_test';
export const TEST_AWS_ENDPOINT = process.env.TEST_AWS_ENDPOINT_URL ?? 'http://localhost:4570';

export const sqs = new SQSClient({
  endpoint: TEST_AWS_ENDPOINT,
  region: 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});

export const sql = new SQL(TEST_DATABASE_URL, { max: 20 });

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function resetDatabase(): Promise<void> {
  await migrate('reset', TEST_DATABASE_URL);
}

export interface TestQueues {
  wager: string;
  dlq: string;
  events: string;
  wagerUrl: string;
  dlqUrl: string;
  eventsUrl: string;
}

/** Filas exclusivas por arquivo de teste, para não haver interferência. */
export async function createQueues(maxReceiveCount = 10): Promise<TestQueues> {
  const id = randomUUID().slice(0, 8);
  const names = { wager: `wt-${id}.fifo`, dlq: `wt-dlq-${id}.fifo`, events: `ev-${id}.fifo` };
  const dlqUrl = (await sqs.send(new CreateQueueCommand({ QueueName: names.dlq, Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'true' } }))).QueueUrl!;
  const dlqArn = (await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }))).Attributes!.QueueArn!;
  const wagerUrl = (
    await sqs.send(
      new CreateQueueCommand({
        QueueName: names.wager,
        Attributes: {
          FifoQueue: 'true',
          ContentBasedDeduplication: 'true',
          VisibilityTimeout: '2',
          RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: String(maxReceiveCount) }),
        },
      }),
    )
  ).QueueUrl!;
  const eventsUrl = (await sqs.send(new CreateQueueCommand({ QueueName: names.events, Attributes: { FifoQueue: 'true' } }))).QueueUrl!;
  return { ...names, wagerUrl, dlqUrl, eventsUrl };
}

export async function deleteQueues(q: TestQueues): Promise<void> {
  for (const url of [q.wagerUrl, q.dlqUrl, q.eventsUrl]) {
    await sqs.send(new DeleteQueueCommand({ QueueUrl: url })).catch(() => undefined);
  }
}

export async function purge(url: string): Promise<void> {
  await sqs.send(new PurgeQueueCommand({ QueueUrl: url })).catch(() => undefined);
}

/** Variáveis de ambiente de uma instância de teste: tempos curtos para os testes serem rápidos. */
export function testEnv(q: TestQueues, extra: Record<string, string> = {}): Record<string, string> {
  return {
    DATABASE_URL: TEST_DATABASE_URL,
    AWS_ENDPOINT_URL: TEST_AWS_ENDPOINT,
    AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'test',
    AWS_SECRET_ACCESS_KEY: 'test',
    SQS_WAGER_QUEUE: q.wager,
    SQS_WAGER_DLQ: q.dlq,
    SQS_EVENTS_QUEUE: q.events,
    SQS_WAIT_TIME_SEC: '1',
    SQS_VISIBILITY_TIMEOUT_SEC: '2',
    SQS_RETRY_BASE_DELAY_SEC: '1',
    SQS_MAX_ATTEMPTS: '3',
    OUTBOX_POLL_MS: '100',
    OUTBOX_LEASE_MS: '3000',
    PENDING_REFERENCE_POLL_MS: '100',
    PENDING_REFERENCE_BASE_DELAY_MS: '200',
    PENDING_REFERENCE_MAX_DELAY_MS: '1000',
    PENDING_REFERENCE_MAX_ATTEMPTS: '4',
    DB_POOL_MAX: '20',
    SHUTDOWN_TIMEOUT_MS: '10000',
    LOG_LEVEL: process.env.TEST_APP_LOG_LEVEL ?? 'error',
    ...extra,
  };
}

export function testConfig(q: TestQueues, extra: Record<string, string> = {}): AppConfig {
  return loadConfig({ ...testEnv(q, extra), PORT: '0' });
}

/** Aplicação Nest no mesmo processo do teste. */
export async function startApp(config: AppConfig): Promise<{ app: INestApplication; url: string }> {
  const app = await bootstrap(config);
  const url = (await app.getUrl()).replace('[::1]', 'localhost');
  return { app, url };
}

let nextPort = 3300 + Math.floor(Math.random() * 500);

export interface Instance {
  proc: Subprocess;
  url: string;
  output: () => string;
  stop(signal?: NodeJS.Signals): Promise<number | null>;
}

/** Sobe uma instância como processo separado (multi-instância de verdade). */
export async function spawnInstance(q: TestQueues, extra: Record<string, string> = {}): Promise<Instance> {
  const port = nextPort++;
  let out = '';
  const proc = Bun.spawn(['bun', 'run', 'src/main.ts'], {
    cwd: `${import.meta.dir}/../..`,
    env: { ...process.env, ...testEnv(q, { PORT: String(port), INSTANCE_ID: `test-${port}`, ...extra }) },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) out += decoder.decode(chunk);
  };
  void collect(proc.stdout as ReadableStream<Uint8Array>);
  void collect(proc.stderr as ReadableStream<Uint8Array>);

  const url = `http://localhost:${port}`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) break;
    try {
      const res = await fetch(`${url}/health/ready`);
      if (res.ok) break;
    } catch {
      /* ainda subindo */
    }
    await sleep(150);
  }
  return {
    proc,
    url,
    output: () => out,
    async stop(signal: NodeJS.Signals = 'SIGTERM') {
      if (proc.exitCode === null && !proc.killed) proc.kill(signal);
      return proc.exited;
    },
  };
}

// ----------------------------------------------------------------- HTTP

export interface HttpResult<T = any> {
  status: number;
  body: T;
}

export async function http<T = any>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<HttpResult<T>> {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

export async function createWallet(baseUrl: string, amount = '100.00', currency = 'BRL', playerId = randomUUID()) {
  const res = await http('POST', `${baseUrl}/wallets`, { playerId, initialBalance: { amount, currency } });
  if (res.status !== 201) throw new Error(`createWallet falhou: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string; playerId: string; balance: { amount: string; currency: string }; version: number };
}

export interface WagerInput {
  providerId?: string;
  externalTransactionId?: string;
  playerId: string;
  walletId: string;
  roundId?: string;
  gameId?: string;
  kind: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
  amount: string;
  currency?: string;
  referenceExternalTransactionId?: string;
}

export function wagerBody(i: WagerInput) {
  return {
    providerId: i.providerId ?? 'provider-a',
    externalTransactionId: i.externalTransactionId ?? `ext-${randomUUID()}`,
    playerId: i.playerId,
    walletId: i.walletId,
    roundId: i.roundId ?? 'round-1',
    gameId: i.gameId ?? 'fortune-chimp',
    kind: i.kind,
    money: { amount: i.amount, currency: i.currency ?? 'BRL' },
    ...(i.referenceExternalTransactionId ? { referenceExternalTransactionId: i.referenceExternalTransactionId } : {}),
  };
}

export function submit(baseUrl: string, body: ReturnType<typeof wagerBody>, key = `${body.providerId}:${body.externalTransactionId}`) {
  return http('POST', `${baseUrl}/wagering/transactions`, body, { 'Idempotency-Key': key });
}

// ----------------------------------------------------------------- SQS

export function wagerMessage(body: ReturnType<typeof wagerBody>, messageId = `msg-${randomUUID()}`) {
  return {
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: { ...body, idempotencyKey: `${body.providerId}:${body.externalTransactionId}` },
  };
}

export async function sendMessage(queueUrl: string, message: unknown, groupId: string, dedupId = randomUUID()) {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: typeof message === 'string' ? message : JSON.stringify(message),
      MessageGroupId: groupId,
      MessageDeduplicationId: dedupId,
    }),
  );
}

/** Lê (e remove) tudo que estiver numa fila até ela ficar vazia por `quietMs`. */
export async function drain(queueUrl: string, quietMs = 1500): Promise<{ body: any; attributes: Record<string, string | undefined> }[]> {
  const all: { body: any; attributes: Record<string, string | undefined> }[] = [];
  let lastSeen = Date.now();
  while (Date.now() - lastSeen < quietMs) {
    const res = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, MessageAttributeNames: ['All'] }),
    );
    const msgs = res.Messages ?? [];
    if (msgs.length === 0) continue;
    lastSeen = Date.now();
    for (const m of msgs) {
      const attributes = Object.fromEntries(Object.entries(m.MessageAttributes ?? {}).map(([k, v]) => [k, v.StringValue]));
      let body: any = m.Body;
      try {
        body = JSON.parse(m.Body ?? '');
      } catch {
        /* corpo inválido de propósito */
      }
      all.push({ body, attributes });
    }
    await sqs.send(
      new DeleteMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: msgs.map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle! })),
      }),
    );
  }
  return all;
}

export async function queueDepth(queueUrl: string): Promise<number> {
  const res = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return Number(res.Attributes?.ApproximateNumberOfMessages ?? 0) + Number(res.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0);
}

// ----------------------------------------------------------------- invariantes

export async function waitFor<T>(fn: () => Promise<T>, predicate: (v: T) => boolean, timeoutMs = 15_000, intervalMs = 100): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T = await fn();
  while (!predicate(last)) {
    if (Date.now() > deadline) throw new Error(`waitFor: condição não satisfeita em ${timeoutMs}ms; último valor: ${JSON.stringify(last)}`);
    await sleep(intervalMs);
    last = await fn();
  }
  return last;
}

/**
 * Invariante final de todos os testes: wallet.balance == saldo reconstruído pelo ledger,
 * o último lançamento termina no saldo atual e a cadeia de versões não tem buracos.
 */
export async function ledgerInvariantViolations(): Promise<unknown[]> {
  return sql`
    with sums as (
      select w.id, w.balance, w.version,
             coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0) as calculated,
             count(l.id) as entries,
             (select balance_after from ledger_entries x where x.wallet_id = w.id order by wallet_version desc limit 1) as last_after,
             coalesce(max(l.wallet_version), 0) as max_version
        from wallets w left join ledger_entries l on l.wallet_id = w.id
       group by w.id)
    select id, balance::text, calculated::text, last_after::text, version, max_version, entries
      from sums
     where balance <> calculated
        or (entries > 0 and last_after <> balance)
        or (entries > 0 and max_version <> version)
        or balance < 0
  `;
}

export async function walletBalance(walletId: string): Promise<string> {
  const [row] = await sql`select balance::text as balance from wallets where id = ${walletId}`;
  return row.balance;
}

export async function ledgerCount(walletId: string, direction?: 'DEBIT' | 'CREDIT'): Promise<number> {
  const [row] = direction
    ? await sql`select count(*)::int as n from ledger_entries where wallet_id = ${walletId} and direction = ${direction}`
    : await sql`select count(*)::int as n from ledger_entries where wallet_id = ${walletId}`;
  return row.n;
}
