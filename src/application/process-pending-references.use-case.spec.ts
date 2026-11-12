import { describe, expect, test } from 'bun:test';
import { Money } from '../domain/money/money';
import { WagerTransactionKind, WagerTransactionStatus } from '../domain/wager/wager-transaction';
import { Wallet } from '../domain/wallet/wallet';
import { Instrumentation, LogFields, noopInstrumentation } from './instrumentation';
import { ProcessPendingReferencesUseCase } from './process-pending-references.use-case';
import { SubmitWagerTransactionUseCase } from './submit-wager-transaction.use-case';
import { InMemoryUnitOfWork } from './testing/in-memory-unit-of-work';
import { WagerProcessor } from './wager-processor';

const WALLET = '0192f291-27dd-7d3f-8071-5f8685deef37';
const PLAYER = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';

describe('ProcessPendingReferencesUseCase', () => {
  test('liquida a pendente quando a referência chega e loga com o correlationId da submissão original', async () => {
    let now = new Date('2026-11-11T12:00:00Z');
    const clock = { now: () => now };
    const uow = new InMemoryUnitOfWork();
    uow.addWallet(Wallet.open({ id: WALLET, playerId: PLAYER, initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }), at: now }));
    const processor = new WagerProcessor({ baseDelayMs: 1000, maxDelayMs: 8000, maxAttempts: 5 }, noopInstrumentation);
    const submit = new SubmitWagerTransactionUseCase(uow, processor, clock, noopInstrumentation);
    const base = {
      providerId: 'provider-a',
      playerId: PLAYER,
      walletId: WALLET,
      roundId: 'r1',
      gameId: 'g',
      money: { amount: '10.00', currency: 'BRL' },
    };

    // ROLLBACK chega antes da BET, numa requisição com correlationId "corr-rollback".
    const rollback = await submit.execute(
      { ...base, externalTransactionId: 'rb-1', idempotencyKey: 'provider-a:rb-1', kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: 'bet-1' },
      { source: 'http', correlationId: 'corr-rollback' },
    );
    expect(rollback.status).toBe(WagerTransactionStatus.PendingReference);
    await submit.execute(
      { ...base, externalTransactionId: 'bet-1', idempotencyKey: 'provider-a:bet-1', kind: WagerTransactionKind.Bet },
      { source: 'http', correlationId: 'corr-bet' },
    );

    // Instrumentação que registra o contexto de log ativo em cada chamada de enrich.
    const contexts: LogFields[] = [];
    let current: LogFields = {};
    const capturing: Instrumentation = {
      ...noopInstrumentation,
      enrich: (fields) => {
        current = { ...current, ...fields };
        contexts.push(current);
      },
      scoped: async (fields, fn) => {
        const previous = current;
        current = { ...fields };
        try {
          return await fn();
        } finally {
          current = previous;
        }
      },
    };

    now = new Date(now.getTime() + 1_500); // passa do primeiro backoff
    const worker = new ProcessPendingReferencesUseCase(uow, processor, clock, capturing);
    const summary = await worker.runOnce(10);

    expect(summary).toMatchObject({ examined: 1, settled: 1 });
    expect(uow.transactions.find((t) => t.id === rollback.transactionId)!.status).toBe(WagerTransactionStatus.Processed);
    expect(uow.wallets.get(WALLET)!.balance.amount).toBe('100.00');
    expect(contexts.at(-1)).toEqual({
      correlationId: 'corr-rollback',
      transactionId: rollback.transactionId,
      walletId: WALLET,
      providerId: 'provider-a',
    });
    expect(current).toEqual({}); // o contexto da pendente não vazou para fora
  });
});
