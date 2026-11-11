import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  createQueues,
  createWallet,
  deleteQueues,
  Instance,
  ledgerCount,
  ledgerInvariantViolations,
  queueDepth,
  resetDatabase,
  sendMessage,
  sleep,
  spawnInstance,
  sql,
  TestQueues,
  waitFor,
  wagerBody,
  wagerMessage,
  walletBalance,
} from './support/harness';

import { Money } from '../src/domain/money/money';

const AMOUNTS = ['1.00', '1.25', '1.50', '1.75', '2.00', '2.25', '2.50'];

/** Processos reais sendo mortos e reiniciados contra Postgres e LocalStack reais. */

let queues: TestQueues;
const running: Instance[] = [];

async function spawn(extra: Record<string, string> = {}) {
  const i = await spawnInstance(queues, extra);
  running.push(i);
  return i;
}

beforeAll(async () => {
  await resetDatabase();
  queues = await createQueues(20);
});

afterAll(async () => {
  await Promise.all(running.map((i) => i.stop('SIGKILL')));
  expect(await ledgerInvariantViolations()).toEqual([]);
  await deleteQueues(queues);
});

describe('recuperação após falhas', () => {
  test('worker morto depois do commit e antes do ack: a redelivery é absorvida pelo inbox', async () => {
    const crashing = await spawn({ FAULT_INJECTION: 'crash-after-commit-before-ack', OUTBOX_PUBLISHER_ENABLED: 'false', PENDING_REFERENCE_WORKER_ENABLED: 'false' });
    const w = await createWallet(crashing.url, '100.00');
    const body = wagerBody({ playerId: w.playerId, walletId: w.id, kind: 'BET', amount: '30.00' });
    const msg = wagerMessage(body);
    await sendMessage(queues.wagerUrl, msg, w.id);

    // O processo faz commit e se mata com SIGKILL antes do DeleteMessage.
    await crashing.proc.exited;
    expect(crashing.proc.signalCode).toBe('SIGKILL');
    expect(await walletBalance(w.id)).toBe('70.00');
    const [inbox] = await sql`select processed_at is not null as processed from inbox_messages where message_id = ${msg.messageId}`;
    expect(inbox.processed).toBe(true);
    expect(await queueDepth(queues.wagerUrl)).toBe(1); // a mensagem não foi confirmada

    // Outra instância recebe a mesma mensagem quando a visibilidade expira.
    const healthy = await spawn();
    await waitFor(() => queueDepth(queues.wagerUrl), (n) => n === 0, 20_000);
    expect(await walletBalance(w.id)).toBe('70.00');
    expect(await ledgerCount(w.id, 'DEBIT')).toBe(1);
    const metrics = await (await fetch(`${healthy.url}/metrics`)).text();
    expect(metrics).toMatch(/wagering_duplicates_detected_total\{type="inbox",source="sqs"\} 1/);
    await healthy.stop();
  });

  test('SIGTERM: termina o que está em andamento, devolve o resto e nada se perde', async () => {
    const node = await spawn({ SQS_CONSUMER_CONCURRENCY: '2', LOG_LEVEL: 'info' });
    const wallets = await Promise.all(Array.from({ length: 6 }, () => createWallet(node.url, '100.00')));
    const sent: { walletId: string; amount: string }[] = [];
    for (let i = 0; i < 60; i++) {
      const w = wallets[i % wallets.length]!;
      await sendMessage(queues.wagerUrl, wagerMessage(wagerBody({ playerId: w.playerId, walletId: w.id, kind: 'BET', amount: '1.00' })), w.id);
      sent.push({ walletId: w.id, amount: '1.00' });
    }
    await sleep(300);
    const exit = await Promise.race([node.stop('SIGTERM').then(() => 'exited'), sleep(15_000).then(() => 'timeout')]);
    expect(exit).toBe('exited');
    expect(node.output()).toContain('encerrado');

    // Uma nova instância processa o que ficou; cada mensagem conta uma única vez.
    const next = await spawn();
    await waitFor(() => queueDepth(queues.wagerUrl), (n) => n === 0, 30_000);
    for (const w of wallets) {
      expect(await walletBalance(w.id)).toBe('90.00');
      expect(await ledgerCount(w.id, 'DEBIT')).toBe(10);
    }
    await next.stop();
  });

  test('três instâncias, uma morre no meio (SIGKILL), reinício: consistência final comprovada', async () => {
    const nodes = [await spawn(), await spawn(), await spawn()];
    const wallets = await Promise.all(Array.from({ length: 5 }, () => createWallet(nodes[0]!.url, '1000.00')));
    const expected = new Map(wallets.map((w) => [w.id, Money.from({ amount: '1000.00', currency: 'BRL' })]));

    // 100 operações (BET e WIN), cada uma enviada duas vezes: duplicatas de verdade.
    for (let i = 0; i < 100; i++) {
      const w = wallets[i % wallets.length]!;
      const kind = i % 4 === 0 ? 'WIN' : 'BET';
      const amount = AMOUNTS[i % AMOUNTS.length]!;
      const money = Money.from({ amount, currency: 'BRL' });
      const msg = wagerMessage(wagerBody({ playerId: w.playerId, walletId: w.id, kind, amount }));
      await sendMessage(queues.wagerUrl, msg, w.id);
      await sendMessage(queues.wagerUrl, msg, `${w.id}-dup`);
      expected.set(w.id, kind === 'WIN' ? expected.get(w.id)!.add(money) : expected.get(w.id)!.subtract(money));
      if (i === 40) await nodes[1]!.stop('SIGKILL'); // morte abrupta no meio da carga
    }

    const restarted = await spawn();
    await waitFor(() => queueDepth(queues.wagerUrl), (n) => n === 0, 60_000);
    // Outbox também drena: nenhum evento confirmado fica para trás.
    await waitFor(async () => (await sql`select count(*)::int as n from outbox_messages where published_at is null`)[0].n, (n) => n === 0, 20_000);

    for (const w of wallets) {
      expect(await walletBalance(w.id)).toBe(expected.get(w.id)!.amount);
    }
    const [{ n }] = await sql`select count(*)::int as n from wager_transactions where kind in ('BET', 'WIN') and wallet_id in ${sql(wallets.map((w) => w.id))}`;
    expect(n).toBe(100);
    expect(await ledgerInvariantViolations()).toEqual([]);

    // Reconciliação pela API em cada wallet.
    for (const w of wallets) {
      const rec = (await (await fetch(`${restarted.url}/wallets/${w.id}/reconciliation`, { method: "POST" })).json()) as { consistent: boolean };
      expect(rec.consistent).toBe(true);
    }
  });
});
