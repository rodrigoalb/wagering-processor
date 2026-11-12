import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { INestApplication } from '@nestjs/common';
import {
  createQueues,
  createWallet,
  deleteQueues,
  http,
  ledgerCount,
  ledgerInvariantViolations,
  postgresProxy,
  queueDepth,
  resetDatabase,
  sendMessage,
  sleep,
  sql,
  startApp,
  submit,
  testConfig,
  TestQueues,
  waitFor,
  wagerBody,
  wagerMessage,
  walletBalance,
} from './support/harness';

/**
 * PostgreSQL temporariamente indisponível ou wallet travada: a API precisa
 * responder falha TRANSITÓRIA (503), nada pode ser gravado pela metade e o
 * reenvio com a mesma chave precisa funcionar quando o banco volta.
 */

let queues: TestQueues;
const apps: INestApplication[] = [];

beforeAll(async () => {
  await resetDatabase();
  queues = await createQueues();
});

afterAll(async () => {
  expect(await ledgerInvariantViolations()).toEqual([]);
  await Promise.all(apps.map((a) => a.close()));
  await deleteQueues(queues);
});

const noWorkers = { SQS_CONSUMER_ENABLED: 'false', OUTBOX_PUBLISHER_ENABLED: 'false', PENDING_REFERENCE_WORKER_ENABLED: 'false' };

describe('PostgreSQL indisponível', () => {
  test('API responde 503 transitório, readiness cai, e o reenvio funciona quando o banco volta', async () => {
    const proxy = postgresProxy();
    await proxy.start();
    const { app, url } = await startApp({ ...testConfig(queues, noWorkers), databaseUrl: proxy.url() });
    apps.push(app);

    const w = await createWallet(url, '100.00');
    const bet = wagerBody({ playerId: w.playerId, walletId: w.id, kind: 'BET', amount: '30.00' });
    expect((await http('GET', `${url}/health/ready`)).status).toBe(200);

    await proxy.stop(); // banco fora do ar

    const down = await fetch(`${url}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': `${bet.providerId}:${bet.externalTransactionId}` },
      body: JSON.stringify(bet),
    });
    expect(down.status).toBe(503);
    expect(down.headers.get('retry-after')).toBe('1');
    expect(((await down.json()) as { error: { code: string } }).error.code).toBe('TRANSIENT_FAILURE');

    const ready = await http('GET', `${url}/health/ready`);
    expect(ready.status).toBe(503);
    expect(ready.body).toMatchObject({ status: 'down', checks: { postgres: { status: 'down' }, sqs: { status: 'ok' } } });
    // Liveness não depende do banco: o processo não deve ser reiniciado por isso.
    expect((await http('GET', `${url}/health/live`)).status).toBe(200);

    // Nada foi gravado durante a indisponibilidade.
    expect(await walletBalance(w.id)).toBe('100.00');
    expect(await ledgerCount(w.id, 'DEBIT')).toBe(0);

    await proxy.start(); // banco volta
    await waitFor(() => http('GET', `${url}/health/ready`), (r) => r.status === 200);

    // O provedor reenvia com a MESMA chave: é processada agora, uma única vez.
    const retry = await submit(url, bet);
    expect(retry.status).toBe(201);
    expect(retry.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '70.00' }, idempotentReplay: false });
    expect(await ledgerCount(w.id, 'DEBIT')).toBe(1);
    await proxy.stop();
  });
});

describe('wallet travada (timeout de lock)', () => {
  /** Segura o lock da linha da wallet, como faria uma transação longa de outra instância. */
  function holdWalletLock(walletId: string) {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const acquired = new Promise<void>((r) => (locked = r));
    const done = sql.begin(async (tx) => {
      await tx`select id from wallets where id = ${walletId} for update`;
      locked();
      await gate;
    });
    return { acquired, release: async () => (release(), done) };
  }

  test('HTTP: falha rápido com 503 (sem multiplicar a espera) e o reenvio é aplicado uma vez', async () => {
    const { app, url } = await startApp(testConfig(queues, { ...noWorkers, DB_LOCK_TIMEOUT_MS: '300' }));
    apps.push(app);
    const w = await createWallet(url, '100.00');
    const bet = wagerBody({ playerId: w.playerId, walletId: w.id, kind: 'BET', amount: '30.00' });

    const lock = holdWalletLock(w.id);
    await lock.acquired;
    const started = performance.now();
    const res = await fetch(`${url}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': `${bet.providerId}:${bet.externalTransactionId}` },
      body: JSON.stringify(bet),
    });
    const elapsed = performance.now() - started;
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('1');
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('CONCURRENCY_CONFLICT');
    // Um único lock_timeout (300 ms), não 5 tentativas.
    expect(elapsed).toBeGreaterThanOrEqual(280);
    expect(elapsed).toBeLessThan(1_000);

    // Outra wallet não é afetada pelo lock desta (não existe lock global).
    const other = await createWallet(url, '10.00');
    expect((await submit(url, wagerBody({ playerId: other.playerId, walletId: other.id, kind: 'BET', amount: '1.00' }))).status).toBe(201);

    await lock.release();
    const retry = await submit(url, bet);
    expect(retry.status).toBe(201);
    expect(await walletBalance(w.id)).toBe('70.00');
    expect(await ledgerCount(w.id, 'DEBIT')).toBe(1);

    const metrics = await (await fetch(`${url}/metrics`)).text();
    expect(metrics).toMatch(/wagering_lock_conflicts_total\{reason="lock-timeout"\} [1-9]/);
  });

  test('SQS: a mensagem volta para a fila com backoff, não vai para a DLQ e é aplicada depois, na ordem', async () => {
    const own = await createQueues();
    const { app, url } = await startApp(
      testConfig(own, { DB_LOCK_TIMEOUT_MS: '300', SQS_MAX_ATTEMPTS: '8', SQS_CONSUMER_CONCURRENCY: '1', OUTBOX_PUBLISHER_ENABLED: 'false' }),
    );
    try {
      const w = await createWallet(url, '100.00');
      const first = wagerBody({ playerId: w.playerId, walletId: w.id, kind: 'BET', amount: '60.00' });
      const second = wagerBody({ playerId: w.playerId, walletId: w.id, kind: 'BET', amount: '60.00' });

      const lock = holdWalletLock(w.id);
      await lock.acquired;
      await sendMessage(own.wagerUrl, wagerMessage(first), w.id);
      await sendMessage(own.wagerUrl, wagerMessage(second), w.id);
      await sleep(1_200); // pelo menos uma tentativa falha por timeout de lock
      const [{ n }] = await sql`select count(*)::int as n from wager_transactions where wallet_id = ${w.id} and kind = 'BET'`;
      expect(n).toBe(0);
      await lock.release();

      await waitFor(() => queueDepth(own.wagerUrl), (d) => d === 0, 30_000);
      const rows = await sql`select external_transaction_id as ext, status from wager_transactions where wallet_id = ${w.id} and kind = 'BET'`;
      const status = Object.fromEntries(rows.map((r: { ext: string; status: string }) => [r.ext, r.status]));
      // A primeira da fila vence; a segunda encontra saldo insuficiente.
      expect(status[first.externalTransactionId]).toBe('PROCESSED');
      expect(status[second.externalTransactionId]).toBe('REJECTED');
      expect(await walletBalance(w.id)).toBe('40.00');
      expect(await queueDepth(own.dlqUrl)).toBe(0);
      const metrics = await (await fetch(`${url}/metrics`)).text();
      expect(metrics).toMatch(/wagering_retries_total\{operation="sqs-message",reason="concurrency_conflict"\} [1-9]/);
    } finally {
      await app.close(); // para o consumidor antes de apagar as filas dele
      await deleteQueues(own);
    }
  });
});
