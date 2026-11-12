import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { INestApplication } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import { noopInstrumentation } from '../src/application/instrumentation';
import { systemClock } from '../src/application/ports';
import { SubmitWagerTransactionUseCase } from '../src/application/submit-wager-transaction.use-case';
import { WagerProcessor } from '../src/application/wager-processor';
import { QueueUrls } from '../src/infrastructure/messaging/sqs';
import { mikroOrmConfig } from '../src/infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from '../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { WagerTransactionsConsumer } from '../src/presentation/sqs/wager-transactions.consumer';
import {
  createQueues,
  createWallet,
  deleteQueues,
  drain,
  ledgerCount,
  ledgerInvariantViolations,
  queueDepth,
  resetDatabase,
  sendMessage,
  sql,
  sqs,
  startApp,
  testConfig,
  TestQueues,
  waitFor,
  wagerBody,
  wagerMessage,
  walletBalance,
} from './support/harness';

let app: INestApplication;
let url: string;
let queues: TestQueues;

beforeAll(async () => {
  await resetDatabase();
  queues = await createQueues();
  ({ app, url } = await startApp(testConfig(queues, { SQS_CONSUMER_CONCURRENCY: '3' })));
});

afterAll(async () => {
  expect(await ledgerInvariantViolations()).toEqual([]);
  await app?.close();
  await deleteQueues(queues);
});

const txStatus = async (provider: string, ext: string) =>
  (await sql`select status, failure_code from wager_transactions where provider_id = ${provider} and external_transaction_id = ${ext}`)[0];

describe('consumidor SQS', () => {
  test('processa a mensagem pelo mesmo caso de uso da API e registra no inbox', async () => {
    const w = await createWallet(url, '100.00');
    const body = wagerBody({ playerId: w.playerId, walletId: w.id, kind: 'BET', amount: '12.50' });
    const msg = wagerMessage(body);
    await sendMessage(queues.wagerUrl, msg, w.id);

    await waitFor(() => txStatus(body.providerId, body.externalTransactionId), (r) => r?.status === 'PROCESSED');
    expect(await walletBalance(w.id)).toBe('87.50');
    const [inbox] = await sql`select processed_at is not null as processed from inbox_messages where message_id = ${msg.messageId}`;
    expect(inbox.processed).toBe(true);
    await waitFor(() => queueDepth(queues.wagerUrl), (n) => n === 0);
  });

  test('redelivery da mesma mensagem (mesmo messageId) não duplica o efeito', async () => {
    const w = await createWallet(url, '100.00');
    const body = wagerBody({ playerId: w.playerId, walletId: w.id, kind: 'BET', amount: '10.00' });
    const msg = wagerMessage(body);
    // Mesmo corpo enviado 5 vezes com dedup ids diferentes: o broker não deduplica, o inbox sim.
    for (let i = 0; i < 5; i++) await sendMessage(queues.wagerUrl, msg, `g-${i}-${w.id}`);

    await waitFor(() => queueDepth(queues.wagerUrl), (n) => n === 0);
    await waitFor(() => txStatus(body.providerId, body.externalTransactionId), (r) => r?.status === 'PROCESSED');
    expect(await walletBalance(w.id)).toBe('90.00');
    expect(await ledgerCount(w.id, 'DEBIT')).toBe(1);
    const [{ n }] = await sql`select count(*)::int as n from inbox_messages where message_id = ${msg.messageId}`;
    expect(n).toBe(1);
  });

  test('mensagens diferentes com a mesma idempotency key viram replay', async () => {
    const w = await createWallet(url, '100.00');
    const body = wagerBody({ playerId: w.playerId, walletId: w.id, kind: 'BET', amount: '10.00' });
    await sendMessage(queues.wagerUrl, wagerMessage(body), w.id);
    await sendMessage(queues.wagerUrl, wagerMessage(body), w.id);
    await waitFor(() => queueDepth(queues.wagerUrl), (n) => n === 0);
    expect(await walletBalance(w.id)).toBe('90.00');
    expect(await ledgerCount(w.id, 'DEBIT')).toBe(1);
  });

  test('rejeição de negócio e conflito de idempotência: ack, sem DLQ', async () => {
    const w = await createWallet(url, '1.00');
    const bet = wagerBody({ playerId: w.playerId, walletId: w.id, kind: 'BET', amount: '50.00' });
    await sendMessage(queues.wagerUrl, wagerMessage(bet), w.id);
    const conflicting = { ...wagerMessage(bet), data: { ...wagerMessage(bet).data, money: { amount: '49.00', currency: 'BRL' } } };
    await sendMessage(queues.wagerUrl, conflicting, w.id);
    await sendMessage(queues.wagerUrl, wagerMessage(wagerBody({ playerId: w.playerId, walletId: randomUUID(), kind: 'BET', amount: '1.00' })), w.id);

    await waitFor(() => queueDepth(queues.wagerUrl), (n) => n === 0);
    expect(await txStatus(bet.providerId, bet.externalTransactionId)).toEqual({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' });
    expect(await queueDepth(queues.dlqUrl)).toBe(0);
  });

  test('mensagem malformada ou payload inválido vai para a DLQ com o motivo', async () => {
    const w = await createWallet(url, '10.00');
    const valid = wagerMessage(wagerBody({ playerId: w.playerId, walletId: w.id, kind: 'BET', amount: '1.00' }));
    await sendMessage(queues.wagerUrl, '{isto não é json', 'bad-1');
    await sendMessage(queues.wagerUrl, { ...valid, data: { ...valid.data, kind: 'OPENING' } }, 'bad-2');
    await sendMessage(queues.wagerUrl, { ...valid, data: { ...valid.data, money: { amount: '1e2', currency: 'BRL' } } }, 'bad-3');

    const dlq = await waitFor(
      async () => (await drain(queues.dlqUrl, 1000)),
      (msgs) => msgs.length > 0,
      15_000,
    ).then(async (first) => [...first, ...(await drain(queues.dlqUrl, 1500))]);
    expect(dlq).toHaveLength(3);
    expect(dlq.map((m) => m.attributes.failureReason).sort()).toEqual(['invalid-message', 'invalid-message', 'invalid-payload']);
    expect(await walletBalance(w.id)).toBe('10.00');
  });
});

describe('messageId reutilizado', () => {
  test('mesmo messageId com outro conteúdo vai para a DLQ com motivo próprio e não altera saldo', async () => {
    const w = await createWallet(url, '100.00');
    const original = wagerMessage(wagerBody({ playerId: w.playerId, walletId: w.id, kind: 'BET', amount: '10.00' }));
    await sendMessage(queues.wagerUrl, original, w.id);
    await waitFor(() => walletBalance(w.id), (b) => b === '90.00');

    // Outro pedido (outra transação, outro valor) reaproveitando o messageId já processado.
    const other = wagerMessage(wagerBody({ playerId: w.playerId, walletId: w.id, kind: 'BET', amount: '50.00' }), original.messageId);
    await sendMessage(queues.wagerUrl, other, w.id);

    const dlq = await waitFor(() => drain(queues.dlqUrl, 800), (m) => m.length > 0, 15_000);
    expect(dlq).toHaveLength(1);
    expect(dlq[0]!.attributes.failureReason).toBe('message-id-reused');
    expect(dlq[0]!.body.data.externalTransactionId).toBe(other.data.externalTransactionId);
    expect(await walletBalance(w.id)).toBe('90.00');
    expect(await txStatus(other.data.providerId, other.data.externalTransactionId)).toBeUndefined();
    expect(await queueDepth(queues.wagerUrl)).toBe(0);
  });
});

describe('falha transitória: retry com backoff e DLQ após o limite', () => {
  test('banco inacessível: mensagem volta para a fila e, esgotadas as tentativas, vai para a DLQ', async () => {
    const own = await createQueues();
    // Banco real, mas inacessível (porta fechada): erro de conexão de verdade, não mock.
    const deadOrm = await MikroORM.init({ ...mikroOrmConfig('postgres://wagering:wagering@localhost:1/wagering', 2), pool: { min: 0, max: 2, acquireTimeoutMillis: 500 }, connect: false });
    const config = testConfig(own, { SQS_MAX_ATTEMPTS: '3', SQS_RETRY_BASE_DELAY_SEC: '1', SQS_CONSUMER_CONCURRENCY: '1' });
    const useCase = new SubmitWagerTransactionUseCase(
      new MikroOrmUnitOfWork(deadOrm, 1000),
      new WagerProcessor(config.pendingReferences, noopInstrumentation),
      systemClock,
      noopInstrumentation,
    );
    const consumer = new WagerTransactionsConsumer(useCase, sqs, new QueueUrls(sqs), config);
    try {
      const msg = wagerMessage(wagerBody({ playerId: randomUUID(), walletId: randomUUID(), kind: 'BET', amount: '1.00' }));
      await sendMessage(own.wagerUrl, msg, 'transient');
      const started = Date.now();
      consumer.start();
      const dlq = await waitFor(() => drain(own.dlqUrl, 500), (m) => m.length > 0, 30_000);
      expect(dlq[0]!.attributes.failureReason).toBe('max-attempts');
      expect(dlq[0]!.attributes.failureDetail).toBe('transient_failure');
      expect(dlq[0]!.body.messageId).toBe(msg.messageId);
      // 3 recebimentos com backoff 1s e 2s entre eles.
      expect(Date.now() - started).toBeGreaterThanOrEqual(2_500);
      expect(await queueDepth(own.wagerUrl)).toBe(0);
    } finally {
      await consumer.stop();
      await deadOrm.close(true);
      await deleteQueues(own);
    }
  });
});

describe('métricas', () => {
  test('expõe as métricas obrigatórias', async () => {
    const text = await (await fetch(`${url}/metrics`)).text();
    for (const name of [
      'wagering_transactions_total',
      'wagering_duplicates_detected_total',
      'wagering_retries_total',
      'wagering_dlq_messages_total',
      'wagering_lock_conflicts_total',
      'wagering_outbox_lag_seconds',
      'wagering_processing_duration_seconds',
    ]) {
      expect(text).toContain(name);
    }
    expect(text).toMatch(/wagering_duplicates_detected_total\{type="inbox",source="sqs"\} [1-9]/);
    expect(text).toMatch(/wagering_dlq_messages_total\{reason="invalid-message"\} 2/);
  });
});
