import { InboxMessage } from '../../domain/messaging/inbox-message';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { LedgerDirection, WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import { Money } from '../../domain/money/money';
import { FailureCode } from '../../domain/wager/failure-code';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wager/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import {
  InboxMessageRecord,
  LedgerEntryRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletRecord,
} from './records';

const opt = <T>(v: T | null | undefined): T | undefined => (v === null ? undefined : v);
const date = (v: Date | string): Date => (v instanceof Date ? v : new Date(v));
const optDate = (v: Date | string | null | undefined): Date | undefined => (v == null ? undefined : date(v));

export const WalletMapper = {
  toDomain(r: WalletRecord): Wallet {
    return Wallet.rehydrate({
      id: r.id,
      playerId: r.playerId,
      currency: r.currency,
      balance: Money.fromPersisted(String(r.balance), r.currency),
      version: Number(r.version),
      createdAt: date(r.createdAt),
      updatedAt: date(r.updatedAt),
    });
  },
  toRecord(w: Wallet): WalletRecord {
    return {
      id: w.id,
      playerId: w.playerId,
      currency: w.currency,
      balance: w.balance.amount,
      version: w.version,
      createdAt: w.createdAt,
      updatedAt: w.updatedAt,
    };
  },
};

export const WagerTransactionMapper = {
  toDomain(r: WagerTransactionRecord): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: r.id,
      providerId: r.providerId,
      externalTransactionId: r.externalTransactionId,
      idempotencyKey: r.idempotencyKey,
      payloadHash: r.payloadHash,
      walletId: r.walletId,
      playerId: r.playerId,
      roundId: r.roundId,
      gameId: r.gameId,
      kind: r.kind as WagerTransactionKind,
      money: Money.fromPersisted(String(r.amount), r.currency),
      referenceExternalTransactionId: opt(r.referenceExternalTransactionId),
      correlationId: r.correlationId,
      createdAt: date(r.createdAt),
      status: r.status as WagerTransactionStatus,
      referenceTransactionId: opt(r.referenceTransactionId),
      failureCode: opt(r.failureCode) as FailureCode | undefined,
      processedAt: optDate(r.processedAt),
      resultBalance: r.resultBalance == null ? undefined : Money.fromPersisted(String(r.resultBalance), r.currency),
      referenceAttempts: Number(r.referenceAttempts),
      nextReferenceAttemptAt: optDate(r.nextReferenceAttemptAt),
      updatedAt: date(r.updatedAt),
    });
  },
  toRecord(t: WagerTransaction): WagerTransactionRecord {
    return {
      id: t.id,
      providerId: t.providerId,
      externalTransactionId: t.externalTransactionId,
      idempotencyKey: t.idempotencyKey,
      payloadHash: t.payloadHash,
      walletId: t.walletId,
      playerId: t.playerId,
      roundId: t.roundId,
      gameId: t.gameId,
      kind: t.kind,
      amount: t.money.amount,
      currency: t.money.currency,
      referenceExternalTransactionId: t.referenceExternalTransactionId ?? null,
      referenceTransactionId: t.referenceTransactionId ?? null,
      status: t.status,
      failureCode: t.failureCode ?? null,
      resultBalance: t.resultBalance?.amount ?? null,
      referenceAttempts: t.referenceAttempts,
      nextReferenceAttemptAt: t.nextReferenceAttemptAt ?? null,
      correlationId: t.correlationId,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      processedAt: t.processedAt ?? null,
    };
  },
};

export const LedgerEntryMapper = {
  toDomain(r: LedgerEntryRecord): WalletLedgerEntry {
    return WalletLedgerEntry.rehydrate({
      id: r.id,
      walletId: r.walletId,
      transactionId: r.transactionId,
      direction: r.direction as LedgerDirection,
      money: Money.fromPersisted(String(r.amount), r.currency),
      balanceBefore: Money.fromPersisted(String(r.balanceBefore), r.currency),
      balanceAfter: Money.fromPersisted(String(r.balanceAfter), r.currency),
      walletVersion: Number(r.walletVersion),
      createdAt: date(r.createdAt),
    });
  },
  toRecord(e: WalletLedgerEntry): LedgerEntryRecord {
    return {
      id: e.id,
      walletId: e.walletId,
      transactionId: e.transactionId,
      direction: e.direction,
      amount: e.money.amount,
      currency: e.money.currency,
      balanceBefore: e.balanceBefore.amount,
      balanceAfter: e.balanceAfter.amount,
      walletVersion: e.walletVersion,
      createdAt: e.createdAt,
    };
  },
};

export const InboxMapper = {
  toDomain(r: InboxMessageRecord): InboxMessage {
    return InboxMessage.rehydrate({
      consumerName: r.consumerName,
      messageId: r.messageId,
      payloadHash: r.payloadHash,
      receivedAt: date(r.receivedAt),
      processedAt: optDate(r.processedAt),
    });
  },
};

/** Linha crua do outbox (snake_case), vinda de SQL nativo. */
export interface OutboxRow {
  id: string;
  aggregate_id: string;
  partition_key: string;
  event_type: string;
  payload: Record<string, unknown> | string;
  occurred_at: Date | string;
  attempts: number;
  next_attempt_at: Date | string | null;
  published_at: Date | string | null;
}

export const OutboxMapper = {
  fromRow(r: OutboxRow): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: r.id,
      aggregateId: r.aggregate_id,
      partitionKey: r.partition_key,
      eventType: r.event_type,
      payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload,
      occurredAt: date(r.occurred_at),
      attempts: Number(r.attempts),
      nextAttemptAt: optDate(r.next_attempt_at),
      publishedAt: optDate(r.published_at),
    });
  },
  toRecord(m: OutboxMessage): OutboxMessageRecord {
    return {
      id: m.id,
      aggregateId: m.aggregateId,
      partitionKey: m.partitionKey,
      eventType: m.eventType,
      payload: m.payload as Record<string, unknown>,
      occurredAt: m.occurredAt,
      attempts: m.attempts,
      nextAttemptAt: m.nextAttemptAt ?? m.occurredAt,
      publishedAt: m.publishedAt ?? null,
      lockedBy: null,
      lockedUntil: null,
    };
  },
};
