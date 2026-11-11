import { describe, expect, test } from 'bun:test';
import { LedgerDirection, WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import { Money } from '../money/money';
import { InvalidTransactionStateError } from '../shared/domain-error';
import { Wallet } from '../wallet/wallet';
import { WalletBalanceChanged } from './events';
import { InboxMessage } from './inbox-message';
import { OutboxMessage } from './outbox-message';

const at = new Date('2026-11-11T12:00:00Z');
const brl = (a: string) => Money.from({ amount: a, currency: 'BRL' });

function balanceChanged() {
  const wallet = Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: brl('10.00'), at });
  const entry = wallet.debit({ transactionId: 't1', money: brl('2.50'), at }) as WalletLedgerEntry;
  return WalletBalanceChanged.from(wallet, entry, { correlationId: 'corr', causationId: 'cause', occurredAt: at });
}

describe('IntegrationEvent', () => {
  test('envelope com eventType e version no tipo e dinheiro como string', () => {
    const json = balanceChanged().toJSON();
    expect(json.eventType).toBe('WalletBalanceChanged');
    expect(json.version).toBe(1);
    expect(json.occurredAt).toBe(at.toISOString());
    expect(json.data).toEqual({
      walletId: 'w1',
      transactionId: 't1',
      direction: LedgerDirection.Debit,
      money: { amount: '2.50', currency: 'BRL' },
      balanceBefore: { amount: '10.00', currency: 'BRL' },
      balanceAfter: { amount: '7.50', currency: 'BRL' },
      walletVersion: 2,
    });
    // JSON estável: serializa e volta igual
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });
});

describe('OutboxMessage', () => {
  test('enqueue nasce pendente e vencido', () => {
    const m = OutboxMessage.enqueue(balanceChanged());
    expect(m.isPending()).toBe(true);
    expect(m.isDue(at)).toBe(true);
    expect(m.eventType).toBe('WalletBalanceChanged');
    expect(m.partitionKey).toBe('w1');
  });

  test('scheduleRetry aplica backoff exponencial limitado', () => {
    const m = OutboxMessage.enqueue(balanceChanged());
    const policy = { baseDelayMs: 1000, maxDelayMs: 5000 };
    const delays = [1, 2, 3, 4, 5].map(() => {
      m.scheduleRetry(at, policy);
      return m.nextAttemptAt!.getTime() - at.getTime();
    });
    expect(delays).toEqual([1000, 2000, 4000, 5000, 5000]);
    expect(m.attempts).toBe(5);
    expect(m.isDue(at)).toBe(false);
  });

  test('publicado não volta a ser pendente', () => {
    const m = OutboxMessage.enqueue(balanceChanged());
    m.markPublished(at);
    expect(m.isPending()).toBe(false);
    expect(() => m.markPublished(at)).toThrow(InvalidTransactionStateError);
    expect(() => m.scheduleRetry(at)).toThrow(InvalidTransactionStateError);
  });
});

describe('InboxMessage', () => {
  test('recebida, depois processada uma única vez', () => {
    const m = InboxMessage.receive({ messageId: 'm', consumerName: 'c', payloadHash: 'h', receivedAt: at });
    expect(m.isProcessed()).toBe(false);
    m.markProcessed(at);
    expect(m.isProcessed()).toBe(true);
    expect(() => m.markProcessed(at)).toThrow(InvalidTransactionStateError);
  });
});
