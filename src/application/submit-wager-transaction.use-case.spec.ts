import { beforeEach, describe, expect, test } from 'bun:test';
import { Money } from '../domain/money/money';
import { WagerTransactionKind } from '../domain/wager/wager-transaction';
import { Wallet } from '../domain/wallet/wallet';
import { ConcurrencyConflictError, IdempotencyConflictError, MessageIdReuseError, WalletNotFoundError } from './errors';
import { noopInstrumentation } from './instrumentation';
import { withConcurrencyRetry } from './retry';
import { SubmitContext, SubmitWagerCommand, SubmitWagerTransactionUseCase } from './submit-wager-transaction.use-case';
import { InMemoryUnitOfWork } from './testing/in-memory-unit-of-work';
import { WagerProcessor } from './wager-processor';

const at = new Date('2026-11-11T12:00:00Z');
const WALLET = '0192f291-27dd-7d3f-8071-5f8685deef37';
const PLAYER = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';

let uow: InMemoryUnitOfWork;
let useCase: SubmitWagerTransactionUseCase;

const bet = (over: Partial<SubmitWagerCommand> = {}): SubmitWagerCommand => ({
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  idempotencyKey: 'provider-a:transaction-123',
  playerId: PLAYER,
  walletId: WALLET,
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: WagerTransactionKind.Bet,
  money: { amount: '25.00', currency: 'BRL' },
  ...over,
});

const http: SubmitContext = { source: 'http', correlationId: 'corr' };
const fromQueue = (messageId: string, payloadHash: string): SubmitContext => ({
  source: 'sqs',
  correlationId: 'corr',
  inbox: { consumerName: 'consumer', messageId, payloadHash },
});

beforeEach(() => {
  uow = new InMemoryUnitOfWork();
  uow.addWallet(Wallet.open({ id: WALLET, playerId: PLAYER, initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }), at }));
  const processor = new WagerProcessor({ baseDelayMs: 1000, maxDelayMs: 8000, maxAttempts: 3 }, noopInstrumentation);
  useCase = new SubmitWagerTransactionUseCase(uow, processor, { now: () => at }, noopInstrumentation);
});

describe('SubmitWagerTransactionUseCase: idempotência', () => {
  test('requisição idêntica devolve o resultado original e não debita de novo', async () => {
    const first = await useCase.execute(bet(), http);
    const replay = await useCase.execute(bet(), http);

    expect(first).toMatchObject({ status: 'PROCESSED', balance: { amount: '75.00' }, idempotentReplay: false });
    expect(replay).toEqual({ ...first, idempotentReplay: true });
    expect(uow.transactions).toHaveLength(1);
    expect(uow.ledger).toHaveLength(1);
    expect(uow.wallets.get(WALLET)!.balance.amount).toBe('75.00');
  });

  test('o replay devolve o saldo observado na época, não o atual', async () => {
    const first = await useCase.execute(bet(), http);
    await useCase.execute(bet({ externalTransactionId: 't-2', idempotencyKey: 'provider-a:t-2', money: { amount: '50.00', currency: 'BRL' } }), http);
    const replay = await useCase.execute(bet(), http);
    expect(replay.balance).toEqual(first.balance);
    expect(uow.wallets.get(WALLET)!.balance.amount).toBe('25.00');
  });

  test.each([
    ['valor', { money: { amount: '26.00', currency: 'BRL' } }],
    ['rodada', { roundId: 'outra-rodada' }],
    ['kind', { kind: WagerTransactionKind.Win }],
  ])('mesma idempotency key com %s diferente é conflito, não replay', async (_, change) => {
    await useCase.execute(bet(), http);
    await expect(useCase.execute(bet(change as Partial<SubmitWagerCommand>), http)).rejects.toThrow(IdempotencyConflictError);
    expect(uow.transactions).toHaveLength(1);
    expect(uow.wallets.get(WALLET)!.balance.amount).toBe('75.00');
  });

  test('mesmo id externo com outra idempotency key também é conflito', async () => {
    await useCase.execute(bet(), http);
    await expect(useCase.execute(bet({ idempotencyKey: 'outra-chave' }), http)).rejects.toThrow(IdempotencyConflictError);
    expect(uow.transactions).toHaveLength(1);
  });

  test('formato do valor não muda a identidade: "25" e "25.00" são o mesmo payload', async () => {
    await useCase.execute(bet(), http);
    const replay = await useCase.execute(bet({ money: { amount: '25', currency: 'BRL' } }), http);
    expect(replay.idempotentReplay).toBe(true);
  });

  test('wallet inexistente não persiste nada', async () => {
    await expect(useCase.execute(bet({ walletId: '0192f291-27dd-7d3f-8071-000000000000' }), http)).rejects.toThrow(WalletNotFoundError);
    expect(uow.transactions).toHaveLength(0);
  });
});

describe('SubmitWagerTransactionUseCase: inbox', () => {
  test('mesma mensagem de novo (mesmo messageId e conteúdo) é duplicata', async () => {
    const first = await useCase.execute(bet(), fromQueue('msg-1', 'hash-a'));
    const again = await useCase.execute(bet(), fromQueue('msg-1', 'hash-a'));
    expect(again).toEqual({ ...first, idempotentReplay: true, duplicateMessage: true });
    expect(uow.ledger).toHaveLength(1);
    expect(uow.inbox.size).toBe(1);
  });

  test('messageId repetido com outro conteúdo não é engolido como duplicata', async () => {
    await useCase.execute(bet(), fromQueue('msg-1', 'hash-a'));
    const other = bet({ externalTransactionId: 't-2', idempotencyKey: 'provider-a:t-2' });
    await expect(useCase.execute(other, fromQueue('msg-1', 'hash-b'))).rejects.toThrow(MessageIdReuseError);
    expect(uow.transactions).toHaveLength(1);
    expect(uow.wallets.get(WALLET)!.balance.amount).toBe('75.00');
  });

  test('falha depois de registrar o inbox desfaz o registro (a mensagem pode ser reprocessada)', async () => {
    await expect(useCase.execute(bet({ walletId: '0192f291-27dd-7d3f-8071-000000000000' }), fromQueue('msg-9', 'h'))).rejects.toThrow(
      WalletNotFoundError,
    );
    expect(uow.inbox.size).toBe(0);
  });
});

describe('withConcurrencyRetry', () => {
  const failing = (reason: ConstructorParameters<typeof ConcurrencyConflictError>[1]) => {
    let calls = 0;
    const fn = async () => {
      calls++;
      throw new ConcurrencyConflictError('conflito', reason);
    };
    return { fn, calls: () => calls };
  };

  test('conflitos rápidos são refeitos até o limite', async () => {
    const f = failing('unique-violation');
    await expect(withConcurrencyRetry(f.fn, noopInstrumentation, { operation: 't', maxAttempts: 4, baseDelayMs: 1 })).rejects.toThrow(
      ConcurrencyConflictError,
    );
    expect(f.calls()).toBe(4);
  });

  test('timeout de lock não é refeito: falha na primeira vez', async () => {
    const f = failing('lock-timeout');
    await expect(withConcurrencyRetry(f.fn, noopInstrumentation, { operation: 't', maxAttempts: 4, baseDelayMs: 1 })).rejects.toThrow(
      ConcurrencyConflictError,
    );
    expect(f.calls()).toBe(1);
  });

  test('sucesso depois de um conflito devolve o resultado', async () => {
    let calls = 0;
    const result = await withConcurrencyRetry(
      async () => {
        if (++calls < 3) throw new ConcurrencyConflictError('conflito', 'deadlock');
        return 'ok';
      },
      noopInstrumentation,
      { operation: 't', baseDelayMs: 1 },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  test('erros que não são de concorrência sobem direto', async () => {
    let calls = 0;
    await expect(
      withConcurrencyRetry(
        async () => {
          calls++;
          throw new Error('outro erro');
        },
        noopInstrumentation,
        { operation: 't' },
      ),
    ).rejects.toThrow('outro erro');
    expect(calls).toBe(1);
  });
});
