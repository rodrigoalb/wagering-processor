import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { CreateWalletUseCase } from '../src/application/create-wallet.use-case';
import { noopInstrumentation } from '../src/application/instrumentation';
import { systemClock } from '../src/application/ports';
import { OutboxPublisher } from '../src/infrastructure/messaging/outbox-publisher';
import { QueueUrls } from '../src/infrastructure/messaging/sqs';
import { mikroOrmConfig } from '../src/infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from '../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { randomUUID } from 'node:crypto';
import {
  createQueues,
  createWallet,
  deleteQueues,
  drain,
  ledgerInvariantViolations,
  resetDatabase,
  spawnInstance,
  sql,
  sqs,
  submit,
  testConfig,
  TestQueues,
  TEST_DATABASE_URL,
  waitFor,
  wagerBody,
} from './support/harness';

let orm: MikroORM;
let uow: MikroOrmUnitOfWork;
let queues: TestQueues;

const pendingCount = async () => (await sql`select count(*)::int as n from outbox_messages where published_at is null`)[0].n as number;

function publisher(instanceId: string, extra: Record<string, string> = {}) {
  const config = testConfig(queues, { INSTANCE_ID: instanceId, OUTBOX_BATCH_SIZE: '7', ...extra });
  return new OutboxPublisher(uow, sqs, new QueueUrls(sqs), config, systemClock);
}

/** Gera eventos no outbox sem publicar (cada wallet com saldo gera 2 eventos). */
async function seedEvents(wallets: number): Promise<number> {
  const create = new CreateWalletUseCase(uow, systemClock, noopInstrumentation);
  for (let i = 0; i < wallets; i++) {
    await create.execute({ playerId: randomUUID(), initialBalance: { amount: '10.00', currency: 'BRL' } }, `corr-${i}`);
  }
  return pendingCount();
}

beforeAll(async () => {
  await resetDatabase();
  queues = await createQueues();
  orm = await MikroORM.init(mikroOrmConfig(TEST_DATABASE_URL, 20));
  uow = new MikroOrmUnitOfWork(orm, 2_000);
});

afterAll(async () => {
  expect(await ledgerInvariantViolations()).toEqual([]);
  await orm?.close(true);
  await deleteQueues(queues);
});

describe('transactional outbox', () => {
  test('dois publishers concorrentes sobre o mesmo outbox: cada evento publicado exatamente uma vez', async () => {
    const total = await seedEvents(30);
    expect(total).toBe(60);
    const a = publisher('pub-a');
    const b = publisher('pub-b');
    const counts = { a: 0, b: 0 };
    // Os dois disputam o mesmo outbox ao mesmo tempo até esvaziar.
    await Promise.all([
      (async () => {
        while ((await pendingCount()) > 0) counts.a += await a.publishBatch('pub-a');
      })(),
      (async () => {
        while ((await pendingCount()) > 0) counts.b += await b.publishBatch('pub-b');
      })(),
    ]);
    expect(counts.a + counts.b).toBe(60);
    expect(counts.a).toBeGreaterThan(0);
    expect(counts.b).toBeGreaterThan(0);

    const received = await drain(queues.eventsUrl);
    const ids = received.map((m) => m.body.eventId);
    expect(ids).toHaveLength(60);
    expect(new Set(ids).size).toBe(60);
  });

  test('evento reivindicado por um publisher que morreu é publicado por outro quando o lease expira', async () => {
    await seedEvents(1);
    // "pub-morto" reivindica com lease de 1s e morre sem publicar nem marcar.
    const claimed = await uow.run((r) => r.outbox.claimDue('pub-morto', 10, 1_000, new Date()));
    expect(claimed).toHaveLength(2);

    const vivo = publisher('pub-vivo');
    expect(await vivo.publishBatch('pub-vivo')).toBe(0); // ainda sob lease
    await Bun.sleep(1_100);
    expect(await vivo.publishBatch('pub-vivo')).toBe(2);
    expect(await pendingCount()).toBe(0);
    expect(await drain(queues.eventsUrl)).toHaveLength(2);
  });

  test('publicou e morreu antes de marcar: republica com o mesmo eventId (duplicata segura)', async () => {
    await seedEvents(1);
    const [m] = await uow.run((r) => r.outbox.claimDue('pub-morto', 1, 1_000, new Date()));
    // Simula a publicação feita pelo publisher que morreu logo depois.
    const events = await new QueueUrls(sqs).get(queues.events);
    const { SendMessageCommand } = await import('@aws-sdk/client-sqs');
    await sqs.send(
      new SendMessageCommand({ QueueUrl: events, MessageBody: JSON.stringify(m!.payload), MessageGroupId: m!.partitionKey, MessageDeduplicationId: m!.eventId }),
    );
    await Bun.sleep(1_100);
    const vivo = publisher('pub-vivo');
    while ((await pendingCount()) > 0) await vivo.publishBatch('pub-vivo');

    const received = await drain(queues.eventsUrl);
    const copies = received.filter((r) => r.body.eventId === m!.eventId);
    // O broker deduplica pelo MessageDeduplicationId (= eventId); se não deduplicasse, o
    // consumidor ainda teria o eventId para descartar a cópia.
    expect(copies.length).toBeGreaterThanOrEqual(1);
    expect(new Set(copies.map((c) => c.body.eventId)).size).toBe(1);
  });

  test('SQS indisponível: lote reagendado com backoff, nada é perdido', async () => {
    await seedEvents(1);
    const quebrado = publisher('pub-quebrado', { SQS_EVENTS_QUEUE: 'fila-que-nao-existe.fifo' });
    expect(await quebrado.publishBatch('pub-quebrado')).toBe(0);
    const rows = await sql`select attempts, next_attempt_at > now() as later, locked_by from outbox_messages where published_at is null`;
    expect(rows).toHaveLength(2);
    expect(rows.every((r: { attempts: number; later: boolean; locked_by: string | null }) => r.attempts === 1 && r.later && r.locked_by === null)).toBe(true);
    await sql`update outbox_messages set next_attempt_at = now() where published_at is null`;
    while ((await pendingCount()) > 0) await publisher('pub-ok').publishBatch('pub-ok');
    expect(await drain(queues.eventsUrl)).toHaveLength(2);
  });

  test('commit confirmado, processo morre antes de publicar, outra instância publica', async () => {
    await drain(queues.eventsUrl, 300);
    // Instância sem publisher: grava no outbox e morre (SIGKILL).
    const a = await spawnInstance(queues, { OUTBOX_PUBLISHER_ENABLED: 'false', SQS_CONSUMER_ENABLED: 'false' });
    const w = await createWallet(a.url, '50.00');
    const bet = await submit(a.url, wagerBody({ playerId: w.playerId, walletId: w.id, kind: 'BET', amount: '5.00' }));
    expect(bet.status).toBe(201);
    await a.stop('SIGKILL');
    expect(await pendingCount()).toBe(4);

    // Outra instância assume e publica.
    const b = await spawnInstance(queues, { SQS_CONSUMER_ENABLED: 'false' });
    try {
      await waitFor(pendingCount, (n) => n === 0);
      const events = (await drain(queues.eventsUrl)).filter((e) => e.body.data?.walletId === w.id);
      expect(events.map((e) => e.body.eventType).sort()).toEqual([
        'WagerTransactionProcessed',
        'WagerTransactionProcessed',
        'WalletBalanceChanged',
        'WalletBalanceChanged',
      ]);
    } finally {
      await b.stop();
    }
  });
});
