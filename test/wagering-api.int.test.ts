import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  createQueues,
  createWallet,
  deleteQueues,
  drain,
  http,
  ledgerCount,
  ledgerInvariantViolations,
  resetDatabase,
  sql,
  startApp,
  submit,
  testConfig,
  TestQueues,
  waitFor,
  wagerBody,
  walletBalance,
} from './support/harness';

let app: INestApplication;
let url: string;
let queues: TestQueues;

beforeAll(async () => {
  await resetDatabase();
  queues = await createQueues();
  ({ app, url } = await startApp(testConfig(queues, { SQS_CONSUMER_ENABLED: 'false' })));
});

afterAll(async () => {
  expect(await ledgerInvariantViolations()).toEqual([]);
  await app?.close();
  await deleteQueues(queues);
});

async function txByExternal(externalId: string, provider = 'provider-a') {
  return (await http('GET', `${url}/providers/${provider}/wagering/transactions/${externalId}`)).body;
}

describe('wallets', () => {
  test('cria wallet com OPENING e lançamento CREDIT na mesma transação', async () => {
    const w = await createWallet(url, '1000.00');
    expect(w).toMatchObject({ balance: { amount: '1000.00', currency: 'BRL' }, version: 1 });
    const [opening] = await sql`select kind, status, amount::text from wager_transactions where wallet_id = ${w.id}`;
    expect(opening).toEqual({ kind: 'OPENING', status: 'PROCESSED', amount: '1000.00' });
    expect(await ledgerCount(w.id, 'CREDIT')).toBe(1);
  });

  test('wallet com saldo zero não gera OPENING nem lançamento', async () => {
    const w = await createWallet(url, '0.00');
    expect(await ledgerCount(w.id)).toBe(0);
    const [{ n }] = await sql`select count(*)::int as n from wager_transactions where wallet_id = ${w.id}`;
    expect(n).toBe(0);
  });

  test('wallet duplicada para o mesmo player e moeda é conflito (409)', async () => {
    const w = await createWallet(url);
    const res = await http('POST', `${url}/wallets`, { playerId: w.playerId, initialBalance: { amount: '1.00', currency: 'BRL' } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('WALLET_ALREADY_EXISTS');
  });

  test('criação concorrente da mesma wallet: exatamente uma vence', async () => {
    const playerId = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => http('POST', `${url}/wallets`, { playerId, initialBalance: { amount: '5.00', currency: 'BRL' } })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(9);
  });

  test('entrada inválida é 400', async () => {
    for (const amount of ['1e2', '-1.00', '1.001', '', 'NaN']) {
      const res = await http('POST', `${url}/wallets`, { playerId: randomUUID(), initialBalance: { amount, currency: 'BRL' } });
      expect(res.status).toBe(400);
    }
    expect((await http('POST', `${url}/wallets`, { playerId: 'x', initialBalance: { amount: '1.00', currency: 'BRL' } })).status).toBe(400);
    expect((await http('GET', `${url}/wallets/${randomUUID()}`)).status).toBe(404);
  });

  test('ledger paginado com cursor estável e opaco', async () => {
    const w = await createWallet(url, '100.00');
    for (let i = 0; i < 5; i++) {
      await submit(url, wagerBody({ playerId: w.playerId, walletId: w.id, kind: 'BET', amount: '1.00' }));
    }
    const versions: number[] = [];
    let cursor: string | null = null;
    do {
      const res: { body: { items: { walletVersion: number }[]; nextCursor: string | null } } = await http(
        'GET',
        `${url}/wallets/${w.id}/ledger?limit=2${cursor ? `&cursor=${cursor}` : ''}`,
      );
      versions.push(...res.body.items.map((i) => i.walletVersion));
      cursor = res.body.nextCursor;
    } while (cursor);
    expect(versions).toEqual([1, 2, 3, 4, 5, 6]);
    expect((await http('GET', `${url}/wallets/${w.id}/ledger?cursor=lixo`)).status).toBe(400);
  });
});

describe('submissão: regras de negócio', () => {
  test('BET debita; WIN credita; LOSS não move saldo', async () => {
    const w = await createWallet(url, '100.00');
    const base = { playerId: w.playerId, walletId: w.id };
    const bet = wagerBody({ ...base, kind: 'BET', amount: '25.00' });
    const r1 = await submit(url, bet);
    expect(r1.status).toBe(201);
    expect(r1.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '75.00' }, idempotentReplay: false });

    const r2 = await submit(url, wagerBody({ ...base, kind: 'WIN', amount: '60.00', referenceExternalTransactionId: bet.externalTransactionId }));
    expect(r2.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '135.00' } });

    const r3 = await submit(url, wagerBody({ ...base, kind: 'LOSS', amount: '25.00' }));
    expect(r3.status).toBe(201);
    expect(r3.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '135.00' } });
    expect(await ledgerCount(w.id)).toBe(3); // OPENING + BET + WIN; LOSS não gera lançamento
  });

  test('BET sem saldo: 422 INSUFFICIENT_FUNDS, sem lançamento', async () => {
    const w = await createWallet(url, '10.00');
    const r = await submit(url, wagerBody({ playerId: w.playerId, walletId: w.id, kind: 'BET', amount: '10.01' }));
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', balance: { amount: '10.00' } });
    expect(await ledgerCount(w.id, 'DEBIT')).toBe(0);
  });

  test('REFUND reverte BET uma única vez; segunda reversão é rejeitada', async () => {
    const w = await createWallet(url, '50.00');
    const base = { playerId: w.playerId, walletId: w.id };
    const bet = wagerBody({ ...base, kind: 'BET', amount: '20.00' });
    await submit(url, bet);
    const refund = await submit(url, wagerBody({ ...base, kind: 'REFUND', amount: '20.00', referenceExternalTransactionId: bet.externalTransactionId }));
    expect(refund.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '50.00' } });
    const again = await submit(url, wagerBody({ ...base, kind: 'REFUND', amount: '20.00', referenceExternalTransactionId: bet.externalTransactionId }));
    expect(again.body).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_ALREADY_REVERSED' });
    const rollback = await submit(url, wagerBody({ ...base, kind: 'ROLLBACK', amount: '20.00', referenceExternalTransactionId: bet.externalTransactionId }));
    expect(rollback.body).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_ALREADY_REVERSED' });
    expect(await walletBalance(w.id)).toBe('50.00');
  });

  test('ROLLBACK de WIN debita; se o saldo não cobre, REVERSAL_INSUFFICIENT_FUNDS (auditável)', async () => {
    const w = await createWallet(url, '10.00');
    const base = { playerId: w.playerId, walletId: w.id };
    const bet = wagerBody({ ...base, kind: 'BET', amount: '10.00' });
    await submit(url, bet);
    const win = wagerBody({ ...base, kind: 'WIN', amount: '30.00', referenceExternalTransactionId: bet.externalTransactionId });
    await submit(url, win);
    await submit(url, wagerBody({ ...base, kind: 'BET', amount: '25.00' })); // saldo 5.00
    const rb = await submit(url, wagerBody({ ...base, kind: 'ROLLBACK', amount: '30.00', referenceExternalTransactionId: win.externalTransactionId }));
    expect(rb.status).toBe(422);
    expect(rb.body).toMatchObject({ status: 'REJECTED', failureCode: 'REVERSAL_INSUFFICIENT_FUNDS', balance: { amount: '5.00' } });
    const persisted = await http('GET', `${url}/wagering/transactions/${rb.body.transactionId}`);
    expect(persisted.body).toMatchObject({ status: 'REJECTED', failureCode: 'REVERSAL_INSUFFICIENT_FUNDS', kind: 'ROLLBACK' });
  });

  test('reversão com valor diferente, de outra rodada ou de tipo inválido é rejeitada', async () => {
    const w = await createWallet(url, '100.00');
    const base = { playerId: w.playerId, walletId: w.id };
    const bet = wagerBody({ ...base, kind: 'BET', amount: '10.00', roundId: 'r-a' });
    await submit(url, bet);
    const ref = bet.externalTransactionId;
    expect((await submit(url, wagerBody({ ...base, kind: 'REFUND', amount: '5.00', roundId: 'r-a', referenceExternalTransactionId: ref }))).body.failureCode).toBe('REFERENCE_AMOUNT_MISMATCH');
    expect((await submit(url, wagerBody({ ...base, kind: 'REFUND', amount: '10.00', roundId: 'r-b', referenceExternalTransactionId: ref }))).body.failureCode).toBe('REFERENCE_MISMATCH');
    const loss = wagerBody({ ...base, kind: 'LOSS', amount: '10.00', roundId: 'r-a' });
    await submit(url, loss);
    expect((await submit(url, wagerBody({ ...base, kind: 'ROLLBACK', amount: '10.00', roundId: 'r-a', referenceExternalTransactionId: loss.externalTransactionId }))).body.failureCode).toBe('REFERENCE_INVALID_KIND');
  });

  test('referência de outro provider não é encontrada (resolução por providerId + id externo)', async () => {
    const w = await createWallet(url, '100.00');
    const base = { playerId: w.playerId, walletId: w.id };
    const bet = wagerBody({ ...base, kind: 'BET', amount: '10.00', providerId: 'provider-x' });
    await submit(url, bet);
    const refund = await submit(url, wagerBody({ ...base, kind: 'REFUND', amount: '10.00', providerId: 'provider-y', referenceExternalTransactionId: bet.externalTransactionId }));
    expect(refund.status).toBe(202);
    expect(refund.body.status).toBe('PENDING_REFERENCE');
  });

  test('conflito de moeda: operação BRL numa wallet USD é rejeitada', async () => {
    const w = await createWallet(url, '100.00', 'USD');
    const r = await submit(url, wagerBody({ playerId: w.playerId, walletId: w.id, kind: 'BET', amount: '1.00', currency: 'BRL' }));
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ status: 'REJECTED', failureCode: 'CURRENCY_MISMATCH', balance: { amount: '100.00', currency: 'USD' } });
  });

  test('player que não é dono da wallet é rejeitado; wallet inexistente é 422 sem persistir', async () => {
    const w = await createWallet(url);
    const r = await submit(url, wagerBody({ playerId: randomUUID(), walletId: w.id, kind: 'BET', amount: '1.00' }));
    expect(r.body.failureCode).toBe('PLAYER_WALLET_MISMATCH');
    const missing = await submit(url, wagerBody({ playerId: randomUUID(), walletId: randomUUID(), kind: 'BET', amount: '1.00' }));
    expect(missing.status).toBe(422);
    expect(missing.body.error.code).toBe('WALLET_NOT_FOUND');
  });

  test('OPENING não pode ser submetido; payload inválido é 400', async () => {
    const w = await createWallet(url);
    const body = { ...wagerBody({ playerId: w.playerId, walletId: w.id, kind: 'BET', amount: '1.00' }), kind: 'OPENING' };
    expect((await http('POST', `${url}/wagering/transactions`, body, { 'Idempotency-Key': 'k' })).status).toBe(400);
    const noRef = wagerBody({ playerId: w.playerId, walletId: w.id, kind: 'REFUND', amount: '1.00' });
    expect((await submit(url, noRef)).status).toBe(400);
    const badMoney = { ...wagerBody({ playerId: w.playerId, walletId: w.id, kind: 'BET', amount: '1.00' }), money: { amount: 1, currency: 'BRL' } };
    expect((await http('POST', `${url}/wagering/transactions`, badMoney, { 'Idempotency-Key': 'k2' })).status).toBe(400);
    const malformed = await fetch(`${url}/wagering/transactions`, { method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'k3' }, body: '{nope' });
    expect(malformed.status).toBe(400);
  });
});

describe('idempotência', () => {
  test('repetir devolve o resultado original, inclusive o saldo daquele momento', async () => {
    const w = await createWallet(url, '100.00');
    const bet = wagerBody({ playerId: w.playerId, walletId: w.id, kind: 'BET', amount: '30.00' });
    const first = await submit(url, bet);
    await submit(url, wagerBody({ playerId: w.playerId, walletId: w.id, kind: 'BET', amount: '50.00' })); // saldo muda depois
    const replay = await submit(url, bet);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    expect(replay.body.balance.amount).toBe('70.00');
    expect(await walletBalance(w.id)).toBe('20.00');
  });

  test('replay de rejeição também devolve o resultado original', async () => {
    const w = await createWallet(url, '1.00');
    const bet = wagerBody({ playerId: w.playerId, walletId: w.id, kind: 'BET', amount: '5.00' });
    const first = await submit(url, bet);
    const replay = await submit(url, bet);
    expect(replay.status).toBe(422);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
  });

  test('mesma Idempotency-Key com payload diferente é 409, não replay', async () => {
    const w = await createWallet(url, '100.00');
    const bet = wagerBody({ playerId: w.playerId, walletId: w.id, kind: 'BET', amount: '10.00' });
    await submit(url, bet);
    const conflict = await submit(url, { ...bet, money: { amount: '10.01', currency: 'BRL' } }, `${bet.providerId}:${bet.externalTransactionId}`);
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
    expect(await walletBalance(w.id)).toBe('90.00');
  });

  test('mesmo id externo com outra Idempotency-Key é 409', async () => {
    const w = await createWallet(url, '100.00');
    const bet = wagerBody({ playerId: w.playerId, walletId: w.id, kind: 'BET', amount: '10.00' });
    await submit(url, bet);
    const res = await submit(url, bet, 'outra-chave');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EXTERNAL_TRANSACTION_CONFLICT');
  });

  test('header ausente é 400; ordem das chaves do JSON não muda o hash', async () => {
    const w = await createWallet(url, '100.00');
    const bet = wagerBody({ playerId: w.playerId, walletId: w.id, kind: 'BET', amount: '10.00' });
    expect((await http('POST', `${url}/wagering/transactions`, bet)).status).toBe(400);
    await submit(url, bet);
    const reordered = Object.fromEntries(Object.entries(bet).reverse()) as typeof bet;
    const replay = await submit(url, reordered, `${bet.providerId}:${bet.externalTransactionId}`);
    expect(replay.body.idempotentReplay).toBe(true);
  });
});

describe('referências fora de ordem', () => {
  test('ROLLBACK antes da BET: 202 PENDING_REFERENCE e depois é aplicado pelo worker', async () => {
    const w = await createWallet(url, '100.00');
    const base = { playerId: w.playerId, walletId: w.id };
    const betExt = `bet-${randomUUID()}`;
    const rollback = wagerBody({ ...base, kind: 'ROLLBACK', amount: '40.00', referenceExternalTransactionId: betExt });
    const rb = await submit(url, rollback);
    expect(rb.status).toBe(202);
    expect(rb.body).toMatchObject({ status: 'PENDING_REFERENCE', balance: { amount: '100.00' } });

    const bet = await submit(url, wagerBody({ ...base, kind: 'BET', amount: '40.00', externalTransactionId: betExt }));
    expect(bet.body.balance.amount).toBe('60.00');

    const settled = await waitFor(
      () => http('GET', `${url}/wagering/transactions/${rb.body.transactionId}`),
      (r) => r.body.status === 'PROCESSED',
    );
    expect(settled.body.referenceTransactionId).toBe(bet.body.transactionId);
    expect(await walletBalance(w.id)).toBe('100.00');

    // Replay depois de liquidada devolve o estado atual (PROCESSED).
    const replay = await submit(url, rollback);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ status: 'PROCESSED', idempotentReplay: true, balance: { amount: '100.00' } });
    expect((await txByExternal(rollback.externalTransactionId)).status).toBe('PROCESSED');
  });

  test('referência que nunca chega: REJECTED com REFERENCE_NOT_FOUND e evento publicado', async () => {
    const w = await createWallet(url, '100.00');
    const refund = await submit(url, wagerBody({ playerId: w.playerId, walletId: w.id, kind: 'REFUND', amount: '10.00', referenceExternalTransactionId: `nunca-${randomUUID()}` }));
    expect(refund.status).toBe(202);
    const final = await waitFor(
      () => http('GET', `${url}/wagering/transactions/${refund.body.transactionId}`),
      (r) => r.body.status === 'REJECTED',
      20_000,
    );
    expect(final.body).toMatchObject({ failureCode: 'REFERENCE_NOT_FOUND', referenceAttempts: 4 });
    const [evt] = await sql`select event_type from outbox_messages where aggregate_id = ${refund.body.transactionId} and event_type = 'WagerTransactionRejected'`;
    expect(evt).toBeDefined();
  });
});

describe('outbox e eventos', () => {
  test('eventos gravados na mesma transação e publicados depois do commit', async () => {
    await drain(queues.eventsUrl, 500);
    const w = await createWallet(url, '100.00');
    const bet = wagerBody({ playerId: w.playerId, walletId: w.id, kind: 'BET', amount: '10.00' });
    const r = await submit(url, bet);
    await submit(url, wagerBody({ playerId: w.playerId, walletId: w.id, kind: 'LOSS', amount: '10.00' }));
    await submit(url, wagerBody({ playerId: w.playerId, walletId: w.id, kind: 'BET', amount: '1000.00' }));

    await waitFor(async () => (await sql`select count(*)::int as n from outbox_messages where published_at is null`)[0].n, (n) => n === 0);
    const events = (await drain(queues.eventsUrl)).filter((e) => e.body.data?.walletId === w.id);
    const types = events.map((e) => e.body.eventType).sort();
    expect(types).toEqual([
      'WagerTransactionProcessed', // OPENING
      'WagerTransactionProcessed', // BET
      'WagerTransactionProcessed', // LOSS (sem WalletBalanceChanged)
      'WagerTransactionRejected',
      'WalletBalanceChanged', // OPENING
      'WalletBalanceChanged', // BET
    ]);
    const balanceChanged = events.find((e) => e.body.eventType === 'WalletBalanceChanged' && e.body.data.transactionId === r.body.transactionId)!;
    expect(balanceChanged.body).toMatchObject({
      version: 1,
      aggregateId: w.id,
      data: { direction: 'DEBIT', money: { amount: '10.00', currency: 'BRL' }, balanceBefore: { amount: '100.00' }, balanceAfter: { amount: '90.00' }, walletVersion: 2 },
    });
    expect(typeof balanceChanged.body.correlationId).toBe('string');
  });
});

describe('reconciliação', () => {
  test('consistente depois de várias operações', async () => {
    const w = await createWallet(url, '100.00');
    await submit(url, wagerBody({ playerId: w.playerId, walletId: w.id, kind: 'BET', amount: '25.00' }));
    const res = await http('POST', `${url}/wallets/${w.id}/reconciliation`);
    expect(res.body).toEqual({
      walletId: w.id,
      storedBalance: { amount: '75.00', currency: 'BRL' },
      calculatedBalance: { amount: '75.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 2,
    });
  });

  test('divergência (forçada contornando os triggers) é sinalizada, não corrigida', async () => {
    const w = await createWallet(url, '100.00');
    // Simula corrupção: desliga os triggers só nesta sessão (requer superusuário).
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update wallets set balance = 90 where id = ${w.id}`;
    });
    const res = await http('POST', `${url}/wallets/${w.id}/reconciliation`);
    expect(res.body).toMatchObject({ consistent: false, difference: { amount: '-10.00' }, storedBalance: { amount: '90.00' } });
    expect(await walletBalance(w.id)).toBe('90.00'); // nada foi corrigido em silêncio
    const metrics = await (await fetch(`${url}/metrics`)).text();
    expect(metrics).toMatch(/wagering_reconciliation_mismatches_total [1-9]/);
    // Restaura para não quebrar a invariante global do arquivo.
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update wallets set balance = 100 where id = ${w.id}`;
    });
  });
});

describe('health', () => {
  test('live e ready sem autenticação', async () => {
    expect((await http('GET', `${url}/health/live`)).body).toEqual({ status: 'ok' });
    const ready = await http('GET', `${url}/health/ready`);
    expect(ready.status).toBe(200);
    expect(ready.body.checks).toMatchObject({ postgres: { status: 'ok' }, sqs: { status: 'ok' } });
  });
});
