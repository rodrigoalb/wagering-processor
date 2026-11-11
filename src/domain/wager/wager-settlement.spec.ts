import { describe, expect, test } from 'bun:test';
import { LedgerDirection } from '../ledger/wallet-ledger-entry';
import { Money } from '../money/money';
import { InvalidTransactionStateError, ValidationError } from '../shared/domain-error';
import { Wallet } from '../wallet/wallet';
import { FailureCode } from './failure-code';
import { WagerSettlement } from './wager-settlement';
import { WagerTransaction, WagerTransactionKind as K, WagerTransactionStatus as S } from './wager-transaction';

const at = new Date('2026-11-11T12:00:00Z');
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
let seq = 0;

function wallet(balance = '100.00') {
  return Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: brl(balance), at });
}

function tx(kind: K, amount: string, extra: Partial<Parameters<typeof WagerTransaction.create>[0]> = {}) {
  seq++;
  return WagerTransaction.create({
    id: `tx-${seq}`,
    providerId: 'prov',
    externalTransactionId: `ext-${seq}`,
    idempotencyKey: `prov:ext-${seq}`,
    payloadHash: 'h',
    walletId: 'w1',
    playerId: 'p1',
    roundId: 'r1',
    gameId: 'g',
    kind,
    money: brl(amount),
    correlationId: 'c',
    createdAt: at,
    ...extra,
  });
}

/** Referência já processada (como viria do banco). */
function processed(t: WagerTransaction, balance = '0.00') {
  t.markProcessed(undefined, at, brl(balance));
  return t;
}

function settle(t: WagerTransaction, w: Wallet, reference?: WagerTransaction, referenceAlreadyReversed = false) {
  return WagerSettlement.settle({ transaction: t, wallet: w, reference, referenceAlreadyReversed, at });
}

describe('WagerTransaction', () => {
  test('nasce PENDING', () => {
    expect(tx(K.Bet, '1.00').status).toBe(S.Pending);
  });

  test('OPENING não pode ser criado por create', () => {
    expect(() => tx(K.Opening, '1.00')).toThrow(ValidationError);
  });

  test('REFUND e ROLLBACK exigem referência', () => {
    expect(() => tx(K.Refund, '1.00')).toThrow(ValidationError);
    expect(() => tx(K.Rollback, '1.00')).toThrow(ValidationError);
  });

  test('BET não aceita referência; valor zero só em LOSS', () => {
    expect(() => tx(K.Bet, '1.00', { referenceExternalTransactionId: 'x' })).toThrow(ValidationError);
    expect(() => tx(K.Bet, '0')).toThrow(ValidationError);
    expect(tx(K.Loss, '0').money.isZero()).toBe(true);
  });

  test('estados terminais não transicionam (erro de programação)', () => {
    for (const finish of [
      (t: WagerTransaction) => t.markProcessed(undefined, at, brl('1.00')),
      (t: WagerTransaction) => t.reject(FailureCode.InsufficientFunds, at, brl('1.00')),
      (t: WagerTransaction) => t.fail(FailureCode.InternalError, at),
    ]) {
      const t = tx(K.Bet, '1.00');
      finish(t);
      expect(t.isTerminal()).toBe(true);
      expect(() => t.markProcessed(undefined, at, brl('1.00'))).toThrow(InvalidTransactionStateError);
      expect(() => t.reject(FailureCode.InsufficientFunds, at, brl('1.00'))).toThrow(InvalidTransactionStateError);
      expect(() => t.fail(FailureCode.InternalError, at)).toThrow(InvalidTransactionStateError);
      expect(() => t.markPendingReference(at, at, brl('1.00'))).toThrow(InvalidTransactionStateError);
    }
  });

  test('PENDING_REFERENCE conta tentativas e pode ser reagendada', () => {
    const t = tx(K.Refund, '1.00', { referenceExternalTransactionId: 'b' });
    t.markPendingReference(at, new Date(at.getTime() + 1000), brl('1.00'));
    t.markPendingReference(at, new Date(at.getTime() + 2000), brl('1.00'));
    expect(t.status).toBe(S.PendingReference);
    expect(t.referenceAttempts).toBe(2);
    t.markProcessed('b-id', at, brl('2.00'));
    expect(t.nextReferenceAttemptAt).toBeUndefined();
  });

  test('matchesPayload compara o hash: mesma chave com payload diferente não é replay', () => {
    const t = tx(K.Bet, '1.00', { payloadHash: 'abc' });
    expect(t.matchesPayload('abc')).toBe(true);
    expect(t.matchesPayload('abd')).toBe(false);
  });

  test('affectsBalance e ledgerDirectionFor', () => {
    expect(tx(K.Loss, '1.00').affectsBalance()).toBe(false);
    expect(tx(K.Bet, '1.00').ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(tx(K.Win, '1.00').ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    const bet = tx(K.Bet, '1.00');
    const win = tx(K.Win, '1.00');
    const rb = tx(K.Rollback, '1.00', { referenceExternalTransactionId: 'x' });
    expect(rb.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rb.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(() => rb.ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
  });
});

describe('WagerSettlement: regras de negócio', () => {
  test('BET debita e gera 1 lançamento DEBIT', () => {
    const w = wallet();
    const r = settle(tx(K.Bet, '25.00'), w);
    expect(r.type).toBe('processed');
    if (r.type !== 'processed') return;
    expect(r.entry!.direction).toBe(LedgerDirection.Debit);
    expect(w.balance.amount).toBe('75.00');
  });

  test('BET sem saldo é rejeitada com INSUFFICIENT_FUNDS e não move saldo', () => {
    const w = wallet('10.00');
    const r = settle(tx(K.Bet, '10.01'), w);
    expect(r).toEqual({ type: 'rejected', code: FailureCode.InsufficientFunds, reference: undefined });
    expect(w.balance.amount).toBe('10.00');
    expect(w.version).toBe(1);
  });

  test('WIN credita, com ou sem referência à BET', () => {
    const w = wallet();
    expect(settle(tx(K.Win, '5.00'), w).type).toBe('processed');
    const bet = processed(tx(K.Bet, '1.00'));
    const r = settle(tx(K.Win, '50.00', { referenceExternalTransactionId: bet.externalTransactionId }), w, bet);
    expect(r.type).toBe('processed');
    expect(w.balance.amount).toBe('155.00');
  });

  test('LOSS registra sem mover saldo e sem lançamento', () => {
    const w = wallet();
    const r = settle(tx(K.Loss, '25.00'), w);
    expect(r).toEqual({ type: 'processed', reference: undefined });
    expect(w.version).toBe(1);
  });

  test('REFUND credita o valor da BET referenciada', () => {
    const w = wallet();
    const bet = processed(tx(K.Bet, '20.00'));
    const r = settle(tx(K.Refund, '20.00', { referenceExternalTransactionId: bet.externalTransactionId }), w, bet);
    expect(r.type).toBe('processed');
    expect(w.balance.amount).toBe('120.00');
  });

  test('REFUND só referencia BET', () => {
    const win = processed(tx(K.Win, '20.00'));
    const r = settle(tx(K.Refund, '20.00', { referenceExternalTransactionId: 'x' }), wallet(), win);
    expect(r.type === 'rejected' && r.code).toBe(FailureCode.ReferenceInvalidKind);
  });

  test('ROLLBACK de BET credita; de WIN debita; de LOSS é inválido', () => {
    const w = wallet();
    const bet = processed(tx(K.Bet, '10.00'));
    settle(tx(K.Rollback, '10.00', { referenceExternalTransactionId: 'x' }), w, bet);
    expect(w.balance.amount).toBe('110.00');
    const win = processed(tx(K.Win, '30.00'));
    settle(tx(K.Rollback, '30.00', { referenceExternalTransactionId: 'x' }), w, win);
    expect(w.balance.amount).toBe('80.00');
    const loss = processed(tx(K.Loss, '1.00'));
    const r = settle(tx(K.Rollback, '1.00', { referenceExternalTransactionId: 'x' }), w, loss);
    expect(r.type === 'rejected' && r.code).toBe(FailureCode.ReferenceInvalidKind);
  });

  test('ROLLBACK de REFUND debita', () => {
    const w = wallet();
    const refund = processed(tx(K.Refund, '10.00', { referenceExternalTransactionId: 'b' }));
    settle(tx(K.Rollback, '10.00', { referenceExternalTransactionId: 'x' }), w, refund);
    expect(w.balance.amount).toBe('90.00');
  });

  test('ROLLBACK que deixaria saldo negativo é rejeitado com código distinto de aposta sem saldo', () => {
    const w = wallet('5.00');
    const win = processed(tx(K.Win, '30.00'));
    const r = settle(tx(K.Rollback, '30.00', { referenceExternalTransactionId: 'x' }), w, win);
    expect(r.type === 'rejected' && r.code).toBe(FailureCode.ReversalInsufficientFunds);
    expect(FailureCode.ReversalInsufficientFunds).not.toBe(FailureCode.InsufficientFunds);
    expect(w.balance.amount).toBe('5.00');
  });

  test('reversão já feita não se repete', () => {
    const bet = processed(tx(K.Bet, '10.00'));
    const r = settle(tx(K.Refund, '10.00', { referenceExternalTransactionId: 'x' }), wallet(), bet, true);
    expect(r.type === 'rejected' && r.code).toBe(FailureCode.ReferenceAlreadyReversed);
  });

  test('reversão parcial é rejeitada', () => {
    const bet = processed(tx(K.Bet, '10.00'));
    const r = settle(tx(K.Refund, '9.99', { referenceExternalTransactionId: 'x' }), wallet(), bet);
    expect(r.type === 'rejected' && r.code).toBe(FailureCode.ReferenceAmountMismatch);
  });

  test.each([
    ['rodada', { roundId: 'outra' }],
    ['player', { playerId: 'outro' }],
    ['provider', { providerId: 'outro' }],
  ])('referência de outro(a) %s é rejeitada', (_, override) => {
    const bet = processed(tx(K.Bet, '10.00', override as never));
    const r = settle(tx(K.Refund, '10.00', { referenceExternalTransactionId: 'x' }), wallet(), bet);
    expect(r.type === 'rejected' && r.code).toBe(FailureCode.ReferenceMismatch);
  });

  test('referência REJECTED não pode ser revertida', () => {
    const bet = tx(K.Bet, '10.00');
    bet.reject(FailureCode.InsufficientFunds, at, brl('0.00'));
    const r = settle(tx(K.Refund, '10.00', { referenceExternalTransactionId: 'x' }), wallet(), bet);
    expect(r.type === 'rejected' && r.code).toBe(FailureCode.ReferenceNotProcessed);
  });

  test('referência ausente ou ainda pendente: aguarda', () => {
    const rb = tx(K.Rollback, '10.00', { referenceExternalTransactionId: 'x' });
    expect(settle(rb, wallet()).type).toBe('awaiting-reference');
    const pendingRef = tx(K.Refund, '10.00', { referenceExternalTransactionId: 'y' });
    pendingRef.markPendingReference(at, at, brl('1.00'));
    expect(settle(tx(K.Rollback, '10.00', { referenceExternalTransactionId: 'z' }), wallet(), pendingRef).type).toBe(
      'awaiting-reference',
    );
  });

  test('conflito de moeda entre operação e wallet é rejeitado', () => {
    const w = Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: Money.from({ amount: '100.00', currency: 'USD' }), at });
    const r = settle(tx(K.Bet, '10.00'), w);
    expect(r.type === 'rejected' && r.code).toBe(FailureCode.CurrencyMismatch);
    expect(w.version).toBe(1);
  });

  test('player diferente do dono da wallet é rejeitado', () => {
    const r = settle(tx(K.Bet, '10.00', { playerId: 'intruso' }), wallet());
    expect(r.type === 'rejected' && r.code).toBe(FailureCode.PlayerWalletMismatch);
  });
});
