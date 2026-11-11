import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../domain/messaging/events';
import { EventContext, IntegrationEvent } from '../domain/messaging/integration-event';
import { OutboxMessage } from '../domain/messaging/outbox-message';
import { FailureCode } from '../domain/wager/failure-code';
import { WagerSettlement } from '../domain/wager/wager-settlement';
import { WagerTransaction, WagerTransactionStatus } from '../domain/wager/wager-transaction';
import { Wallet } from '../domain/wallet/wallet';
import { Instrumentation, Source } from './instrumentation';
import { TransactionalRepositories } from './ports';

export interface PendingReferencePolicy {
  baseDelayMs: number;
  maxDelayMs: number;
  /** Tentativas sem a referência antes de rejeitar com REFERENCE_NOT_FOUND. */
  maxAttempts: number;
}

export interface SettleOptions {
  /** true: primeira vez (INSERT); false: reprocessamento de PENDING_REFERENCE (UPDATE). */
  isNew: boolean;
  now: Date;
  events: Omit<EventContext, 'occurredAt'>;
  source: Source;
}

/**
 * Aplica uma transação sobre a wallet já travada e persiste tudo na mesma
 * transação SQL: status da transação, saldo, lançamento e eventos (outbox).
 * Compartilhado pela submissão (HTTP e SQS) e pelo worker de referências.
 */
export class WagerProcessor {
  constructor(
    private readonly policy: PendingReferencePolicy,
    private readonly instrumentation: Instrumentation,
  ) {}

  nextAttemptDelayMs(attemptsSoFar: number): number {
    return Math.min(this.policy.baseDelayMs * 2 ** attemptsSoFar, this.policy.maxDelayMs);
  }

  async settle(r: TransactionalRepositories, tx: WagerTransaction, wallet: Wallet, opts: SettleOptions): Promise<void> {
    const { now } = opts;
    const previousStatus = tx.status;
    const previousVersion = wallet.version;

    const reference = tx.referenceExternalTransactionId
      ? await r.transactions.findByExternalId(tx.providerId, tx.referenceExternalTransactionId)
      : undefined;
    const referenceAlreadyReversed =
      reference && tx.isReversal() && reference.status === WagerTransactionStatus.Processed
        ? await r.transactions.hasProcessedReversal(reference.id)
        : false;

    const outcome = WagerSettlement.settle({ transaction: tx, wallet, reference, referenceAlreadyReversed, at: now });

    const ctx: EventContext = { ...opts.events, occurredAt: now };
    const events: IntegrationEvent<unknown>[] = [];
    let entry = undefined;

    switch (outcome.type) {
      case 'processed':
        tx.markProcessed(outcome.reference?.id, now, wallet.balance);
        events.push(WagerTransactionProcessed.from(tx, ctx));
        if (outcome.entry) {
          entry = outcome.entry;
          events.push(WalletBalanceChanged.from(wallet, outcome.entry, ctx));
        }
        break;
      case 'rejected':
        tx.reject(outcome.code, now, wallet.balance, outcome.reference?.id);
        events.push(WagerTransactionRejected.from(tx, ctx));
        break;
      case 'awaiting-reference':
        if (tx.referenceAttempts >= this.policy.maxAttempts) {
          tx.reject(FailureCode.ReferenceNotFound, now, wallet.balance);
          events.push(WagerTransactionRejected.from(tx, ctx));
          this.instrumentation.referenceExpired(tx.id);
        } else {
          const firstTime = previousStatus !== WagerTransactionStatus.PendingReference;
          tx.markPendingReference(now, new Date(now.getTime() + this.nextAttemptDelayMs(tx.referenceAttempts)), wallet.balance);
          // Publica uma vez, quando a transação entra em espera; as novas tentativas não geram ruído.
          if (firstTime) events.push(WagerTransactionPendingReference.from(tx, ctx));
        }
        break;
    }

    // Ordem importa: a transação existe antes do lançamento (FK) e a wallet é
    // atualizada antes do lançamento (trigger confere saldo/versão).
    if (opts.isNew) {
      await r.transactions.insert(tx);
    } else {
      await r.transactions.updateStatus(tx, previousStatus);
    }
    if (entry) {
      await r.wallets.saveBalance(wallet, previousVersion);
      await r.ledger.insert(entry);
    }
    if (tx.status === WagerTransactionStatus.Processed) {
      // Quem esperava por esta transação como referência é reprocessado já.
      await r.transactions.wakeDependents(tx.providerId, tx.externalTransactionId, now);
    }
    await r.outbox.enqueue(events.map((e) => OutboxMessage.enqueue(e)));

    this.instrumentation.transactionSettled(tx.kind, tx.status, opts.source);
    this.instrumentation.info('transação liquidada', {
      kind: tx.kind,
      status: tx.status,
      failureCode: tx.failureCode,
      walletVersion: wallet.version,
    });
  }
}
