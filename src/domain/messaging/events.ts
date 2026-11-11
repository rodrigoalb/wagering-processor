import { LedgerDirection, WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import { MoneyProps } from '../money/money';
import { newId } from '../shared/id';
import { FailureCode } from '../wager/failure-code';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../wager/wager-transaction';
import { Wallet } from '../wallet/wallet';
import { EventContext, IntegrationEvent } from './integration-event';

interface WagerTransactionData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  status: WagerTransactionStatus;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
}

function wagerData(tx: WagerTransaction): WagerTransactionData {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    status: tx.status,
    ...(tx.referenceExternalTransactionId ? { referenceExternalTransactionId: tx.referenceExternalTransactionId } : {}),
    ...(tx.referenceTransactionId ? { referenceTransactionId: tx.referenceTransactionId } : {}),
  };
}

function baseProps(aggregateId: string, ctx: EventContext) {
  return {
    eventId: newId(ctx.occurredAt.getTime()),
    aggregateId,
    correlationId: ctx.correlationId,
    causationId: ctx.causationId,
    occurredAt: ctx.occurredAt,
  };
}

// ---------------------------------------------------------------------------

export interface WagerTransactionProcessedData extends WagerTransactionData {
  balance: MoneyProps;
  processedAt: string;
}

/** Qualquer transação aplicada, inclusive LOSS e OPENING. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed({
      ...baseProps(tx.id, ctx),
      data: {
        ...wagerData(tx),
        balance: tx.resultBalance!.toJSON(),
        processedAt: tx.processedAt!.toISOString(),
      },
    });
  }

  partitionKey(): string {
    return this.data.walletId;
  }
}

export interface WagerTransactionRejectedData extends WagerTransactionData {
  failureCode: FailureCode;
  balance: MoneyProps;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected({
      ...baseProps(tx.id, ctx),
      data: { ...wagerData(tx), failureCode: tx.failureCode!, balance: tx.resultBalance!.toJSON() },
    });
  }

  partitionKey(): string {
    return this.data.walletId;
  }
}

export interface WagerTransactionPendingReferenceData extends WagerTransactionData {
  attempt: number;
  nextAttemptAt: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({
      ...baseProps(tx.id, ctx),
      data: {
        ...wagerData(tx),
        attempt: tx.referenceAttempts,
        nextAttemptAt: tx.nextReferenceAttemptAt!.toISOString(),
      },
    });
  }

  partitionKey(): string {
    return this.data.walletId;
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

/** Somente quando o saldo muda. */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged({
      ...baseProps(wallet.id, ctx),
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: entry.walletVersion,
      },
    });
  }

  partitionKey(): string {
    return this.data.walletId;
  }
}
