import { describe, expect, test } from 'bun:test';
import { LedgerDirection, WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import { Money } from '../money/money';
import { CurrencyMismatchError, InsufficientFundsError, UnbalancedLedgerEntryError, ValidationError } from '../shared/domain-error';
import { Wallet } from './wallet';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-11-11T12:00:00Z');
const open = (amount = '100.00') => Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: brl(amount), at });

describe('Wallet', () => {
  test('abre com versão 1 e o saldo inicial', () => {
    const w = open();
    expect(w.version).toBe(1);
    expect(w.balance.amount).toBe('100.00');
    expect(w.currency).toBe('BRL');
  });

  test('lançamento de abertura: 0 -> saldo inicial, versão 1', () => {
    const entry = open().openingEntry('tx-open')!;
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceBefore.amount).toBe('0.00');
    expect(entry.balanceAfter.amount).toBe('100.00');
    expect(entry.walletVersion).toBe(1);
  });

  test('wallet aberta com zero não tem lançamento de abertura', () => {
    expect(open('0').openingEntry('tx')).toBeUndefined();
  });

  test('debit gera lançamento consistente, incrementa versão e muda o saldo', () => {
    const w = open();
    const entry = w.debit({ transactionId: 't1', money: brl('30.00'), at });
    expect(w.balance.amount).toBe('70.00');
    expect(w.version).toBe(2);
    expect(entry.balanceBefore.amount).toBe('100.00');
    expect(entry.balanceAfter.amount).toBe('70.00');
    expect(entry.walletVersion).toBe(2);
    expect(entry.isBalanced()).toBe(true);
  });

  test('credit incrementa versão', () => {
    const w = open();
    w.credit({ transactionId: 't1', money: brl('0.50'), at });
    expect(w.balance.amount).toBe('100.50');
    expect(w.version).toBe(2);
  });

  test('saldo nunca fica negativo: debit além do saldo lança e não altera estado', () => {
    const w = open('10.00');
    expect(() => w.debit({ transactionId: 't1', money: brl('10.01'), at })).toThrow(InsufficientFundsError);
    expect(w.balance.amount).toBe('10.00');
    expect(w.version).toBe(1);
  });

  test('debit do saldo exato zera a carteira', () => {
    const w = open('10.00');
    w.debit({ transactionId: 't1', money: brl('10.00'), at });
    expect(w.balance.isZero()).toBe(true);
  });

  test('conflito de moeda é rejeitado e não altera estado', () => {
    const w = open();
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => w.debit({ transactionId: 't', money: usd, at })).toThrow(CurrencyMismatchError);
    expect(() => w.credit({ transactionId: 't', money: usd, at })).toThrow(CurrencyMismatchError);
    expect(w.version).toBe(1);
  });

  test('movimentação de valor zero é inválida (version só muda quando o saldo muda)', () => {
    const w = open();
    expect(() => w.credit({ transactionId: 't', money: brl('0'), at })).toThrow(ValidationError);
    expect(w.version).toBe(1);
  });

  test('rehydrate reconstrói sem revalidar', () => {
    const w = Wallet.rehydrate({
      id: 'w',
      playerId: 'p',
      currency: 'BRL',
      balance: brl('5.00'),
      version: 42,
      createdAt: at,
      updatedAt: at,
    });
    expect(w.version).toBe(42);
    expect(w.balance.amount).toBe('5.00');
  });
});

describe('WalletLedgerEntry', () => {
  const base = {
    id: 'e',
    walletId: 'w',
    transactionId: 't',
    walletVersion: 2,
    createdAt: at,
  };

  test('create valida a aritmética', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl('10.00'),
        balanceBefore: brl('100.00'),
        balanceAfter: brl('95.00'),
      }),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  test('não aceita valor zero nem saldo negativo', () => {
    expect(() =>
      WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Credit, money: brl('0'), balanceBefore: brl('1.00'), balanceAfter: brl('1.00') }),
    ).toThrow(UnbalancedLedgerEntryError);
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl('2.00'),
        balanceBefore: brl('1.00'),
        balanceAfter: Money.fromPersisted('-1.00', 'BRL'),
      }),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  test('é estruturalmente imutável', () => {
    const e = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Credit,
      money: brl('1.00'),
      balanceBefore: brl('1.00'),
      balanceAfter: brl('2.00'),
    });
    expect(Object.isFrozen(e)).toBe(true);
    expect(() => {
      (e as unknown as { direction: string }).direction = 'DEBIT';
    }).toThrow();
  });
});
