import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { INestApplication } from '@nestjs/common';
import {
  createQueues,
  createWallet,
  deleteQueues,
  Instance,
  ledgerCount,
  ledgerInvariantViolations,
  resetDatabase,
  spawnInstance,
  sql,
  startApp,
  submit,
  testConfig,
  TestQueues,
  waitFor,
  wagerBody,
  walletBalance,
} from './support/harness';

/** Paralelismo real: requisições disparadas ao mesmo tempo, sem serialização no teste. */

let app: INestApplication;
let url: string;
let queues: TestQueues;
const instances: Instance[] = [];

beforeAll(async () => {
  await resetDatabase();
  queues = await createQueues();
  ({ app, url } = await startApp(testConfig(queues, { SQS_CONSUMER_ENABLED: 'false', DB_POOL_MAX: '60' })));
});

afterAll(async () => {
  await Promise.all(instances.map((i) => i.stop()));
  expect(await ledgerInvariantViolations()).toEqual([]);
  await app?.close();
  await deleteQueues(queues);
});

describe('concorrência na mesma wallet', () => {
  test('a mesma aposta enviada 50 vezes em paralelo gera um único débito', async () => {
    const w = await createWallet(url, '100.00');
    const bet = wagerBody({ playerId: w.playerId, walletId: w.id, kind: 'BET', amount: '7.00' });
    const results = await Promise.all(Array.from({ length: 50 }, () => submit(url, bet)));

    const unexpected = results.filter((r) => r.status !== 201 && r.status !== 200);
    expect(unexpected.map((r) => [r.status, r.body])).toEqual([]);
    expect(results.filter((r) => r.body.idempotentReplay === false)).toHaveLength(1);
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    expect(results.every((r) => r.body.balance.amount === '93.00')).toBe(true);
    expect(await ledgerCount(w.id, 'DEBIT')).toBe(1);
    expect(await walletBalance(w.id)).toBe('93.00');
  });

  test('cenário obrigatório: saldo 100, duas apostas de 80 simultâneas', async () => {
    const w = await createWallet(url, '100.00');
    const betA = wagerBody({ playerId: w.playerId, walletId: w.id, kind: 'BET', amount: '80.00' });
    const betB = wagerBody({ playerId: w.playerId, walletId: w.id, kind: 'BET', amount: '80.00' });

    const [a, b] = await Promise.all([submit(url, betA), submit(url, betB)]);
    const statuses = [a.body.status, b.body.status].sort();
    expect(statuses).toEqual(['PROCESSED', 'REJECTED']);
    const rejected = [a, b].find((r) => r.body.status === 'REJECTED')!;
    expect(rejected.status).toBe(422);
    expect(rejected.body.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(await walletBalance(w.id)).toBe('20.00');
    expect(await ledgerCount(w.id, 'DEBIT')).toBe(1);

    // Nenhum retry duplica o débito: reenvia as duas, várias vezes, em paralelo.
    const retries = await Promise.all([...Array(10)].flatMap(() => [submit(url, betA), submit(url, betB)]));
    expect(retries.every((r) => r.body.idempotentReplay === true)).toBe(true);
    expect(await walletBalance(w.id)).toBe('20.00');
    expect(await ledgerCount(w.id, 'DEBIT')).toBe(1);
  });

  test('hot wallet: 100 apostas distintas disputando o saldo nunca deixam saldo negativo', async () => {
    const w = await createWallet(url, '100.00');
    const results = await Promise.all(
      Array.from({ length: 100 }, () => submit(url, wagerBody({ playerId: w.playerId, walletId: w.id, kind: 'BET', amount: '3.00' }))),
    );
    const processed = results.filter((r) => r.body.status === 'PROCESSED').length;
    const rejected = results.filter((r) => r.body.failureCode === 'INSUFFICIENT_FUNDS').length;
    expect(processed).toBe(33); // 33 * 3.00 = 99.00
    expect(rejected).toBe(67);
    expect(await walletBalance(w.id)).toBe('1.00');
    expect(await ledgerCount(w.id, 'DEBIT')).toBe(33);
  });

  test('REFUND e ROLLBACK simultâneos da mesma BET: só um reverte', async () => {
    const w = await createWallet(url, '100.00');
    const base = { playerId: w.playerId, walletId: w.id };
    const bet = wagerBody({ ...base, kind: 'BET', amount: '40.00' });
    await submit(url, bet);
    const ref = bet.externalTransactionId;
    const results = await Promise.all([
      ...Array.from({ length: 5 }, () => submit(url, wagerBody({ ...base, kind: 'REFUND', amount: '40.00', referenceExternalTransactionId: ref }))),
      ...Array.from({ length: 5 }, () => submit(url, wagerBody({ ...base, kind: 'ROLLBACK', amount: '40.00', referenceExternalTransactionId: ref }))),
    ]);
    expect(results.filter((r) => r.body.status === 'PROCESSED')).toHaveLength(1);
    expect(results.filter((r) => r.body.failureCode === 'REFERENCE_ALREADY_REVERSED')).toHaveLength(9);
    expect(await walletBalance(w.id)).toBe('100.00');
  });
});

describe('wallets distintas em paralelo', () => {
  test('20 wallets x 10 apostas, tudo ao mesmo tempo, cada uma com o saldo exato', async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, () => createWallet(url, '50.00')));
    const started = performance.now();
    await Promise.all(
      wallets.flatMap((w) =>
        Array.from({ length: 10 }, () => submit(url, wagerBody({ playerId: w.playerId, walletId: w.id, kind: 'BET', amount: '2.50' }))),
      ),
    );
    const elapsed = performance.now() - started;
    for (const w of wallets) {
      expect(await walletBalance(w.id)).toBe('25.00');
      expect(await ledgerCount(w.id, 'DEBIT')).toBe(10);
    }
    // Sem lock global: 200 operações em wallets diferentes não são serializadas numa fila única.
    expect(elapsed).toBeLessThan(15_000);
  });
});

describe('três instâncias (processos separados) ao mesmo tempo', () => {
  test('cada aposta enviada às 3 instâncias simultaneamente: um débito por aposta, saldo exato', async () => {
    for (let i = 0; i < 3; i++) {
      instances.push(await spawnInstance(queues, { SQS_CONSUMER_ENABLED: 'false' }));
    }
    const urls = instances.map((i) => i.url);
    for (const u of urls) expect((await fetch(`${u}/health/ready`)).status).toBe(200);

    const w = await createWallet(urls[0]!, '100.00');
    const bets = Array.from({ length: 30 }, () => wagerBody({ playerId: w.playerId, walletId: w.id, kind: 'BET', amount: '5.00' }));
    // 30 apostas distintas x 3 instâncias = 90 requisições concorrentes.
    const results = await Promise.all(bets.flatMap((b) => urls.map((u) => submit(u, b))));

    const firstResults = results.filter((r) => r.body.idempotentReplay === false);
    expect(firstResults).toHaveLength(30); // cada aposta processada uma única vez no total
    expect(firstResults.filter((r) => r.body.status === 'PROCESSED')).toHaveLength(20);
    expect(firstResults.filter((r) => r.body.failureCode === 'INSUFFICIENT_FUNDS')).toHaveLength(10);
    expect(await walletBalance(w.id)).toBe('0.00');
    expect(await ledgerCount(w.id, 'DEBIT')).toBe(20);

    const [{ n }] = await sql`select count(*)::int as n from wager_transactions where wallet_id = ${w.id} and kind = 'BET'`;
    expect(n).toBe(30);
  });

  test('worker de referências pendentes em várias instâncias: cada pendente é liquidada uma única vez', async () => {
    // Quatro workers disputam as mesmas pendentes: as 3 instâncias acima e a aplicação do teste.
    const target = instances[0]!.url;
    const w = await createWallet(target, '100.00');
    const base = { playerId: w.playerId, walletId: w.id };

    // 15 ROLLBACKs chegam antes das BETs; 5 REFUNDs apontam para apostas que nunca chegarão.
    const betIds = Array.from({ length: 15 }, (_, i) => `bet-late-${w.id}-${i}`);
    const rollbacks = await Promise.all(
      betIds.map((ref) => submit(target, wagerBody({ ...base, kind: 'ROLLBACK', amount: '4.00', referenceExternalTransactionId: ref }))),
    );
    const orphans = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        submit(target, wagerBody({ ...base, kind: 'REFUND', amount: '4.00', referenceExternalTransactionId: `nunca-${w.id}-${i}` })),
      ),
    );
    expect([...rollbacks, ...orphans].every((r) => r.status === 202)).toBe(true);

    await Promise.all(betIds.map((ext) => submit(target, wagerBody({ ...base, kind: 'BET', amount: '4.00', externalTransactionId: ext }))));

    const ids = [...rollbacks, ...orphans].map((r) => r.body.transactionId as string);
    type Row = { id: string; status: string; failure_code: string | null };
    const finalRows = await waitFor<Row[]>(
      async () => [...(await sql`select id, status, failure_code from wager_transactions where id in ${sql(ids)}`)],
      (rows) => rows.every((r) => r.status === 'PROCESSED' || r.status === 'REJECTED'),
      30_000,
    );
    const byId = new Map(finalRows.map((r) => [r.id, r]));
    for (const r of rollbacks) expect(byId.get(r.body.transactionId)!.status).toBe('PROCESSED');
    for (const r of orphans) expect(byId.get(r.body.transactionId)).toMatchObject({ status: 'REJECTED', failure_code: 'REFERENCE_NOT_FOUND' });

    // 15 apostas debitadas e 15 revertidas: saldo volta ao inicial, com exatamente um crédito por rollback.
    expect(await walletBalance(w.id)).toBe('100.00');
    expect(await ledgerCount(w.id, 'DEBIT')).toBe(15);
    expect(await ledgerCount(w.id, 'CREDIT')).toBe(1 + 15); // OPENING + rollbacks
    // Um único evento de resultado por pendente, mesmo com 4 workers concorrendo.
    const events = await sql`
      select aggregate_id, count(*)::int as n from outbox_messages
       where aggregate_id in ${sql(ids)} and event_type in ('WagerTransactionProcessed', 'WagerTransactionRejected')
       group by aggregate_id`;
    expect(events).toHaveLength(20);
    expect(events.every((e: { n: number }) => e.n === 1)).toBe(true);
  });
});
