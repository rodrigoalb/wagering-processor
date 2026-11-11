import { LedgerDirection, WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import { Wallet } from '../wallet/wallet';
import { FailureCode } from './failure-code';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from './wager-transaction';

/** Que tipos cada operação pode referenciar. */
const ALLOWED_REFERENCE_KINDS: Partial<Record<WagerTransactionKind, readonly WagerTransactionKind[]>> = {
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund],
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
};

export type SettlementOutcome =
  | { type: 'processed'; entry?: WalletLedgerEntry; reference?: WagerTransaction }
  | { type: 'rejected'; code: FailureCode; reference?: WagerTransaction }
  | { type: 'awaiting-reference' };

export interface SettlementInput {
  transaction: WagerTransaction;
  wallet: Wallet;
  /** Resultado da busca por (providerId, referenceExternalTransactionId); undefined se ausente. */
  reference?: WagerTransaction;
  /** Já existe um REFUND/ROLLBACK PROCESSED para a referência? */
  referenceAlreadyReversed: boolean;
  at: Date;
}

/**
 * Serviço de domínio com as regras da seção 7. Puro: recebe a wallet já
 * travada e a referência já carregada, decide o resultado e, quando há
 * movimentação, aplica na wallet (que devolve o lançamento).
 *
 * Não muda o status da transação: quem chama aplica a transição, porque a
 * política de tentativas de PENDING_REFERENCE é da aplicação.
 */
export class WagerSettlement {
  static settle(input: SettlementInput): SettlementOutcome {
    const { transaction: tx, wallet, at } = input;

    if (tx.money.currency !== wallet.currency) {
      return { type: 'rejected', code: FailureCode.CurrencyMismatch };
    }
    if (tx.playerId !== wallet.playerId || tx.walletId !== wallet.id) {
      return { type: 'rejected', code: FailureCode.PlayerWalletMismatch };
    }

    let reference: WagerTransaction | undefined;
    if (tx.hasReference()) {
      const ref = input.reference;
      if (!ref || !ref.isTerminal()) {
        // Referência ainda não chegou, ou chegou mas também está pendente.
        return { type: 'awaiting-reference' };
      }
      const violation = WagerSettlement.referenceViolation(tx, ref, input.referenceAlreadyReversed);
      if (violation) {
        return { type: 'rejected', code: violation, reference: ref };
      }
      reference = ref;
    }

    if (!tx.affectsBalance()) {
      return { type: 'processed', reference };
    }

    const direction = tx.ledgerDirectionFor(reference);
    if (direction === LedgerDirection.Debit && !wallet.canDebit(tx.money)) {
      const code =
        tx.kind === WagerTransactionKind.Bet ? FailureCode.InsufficientFunds : FailureCode.ReversalInsufficientFunds;
      return { type: 'rejected', code, reference };
    }

    const movement = { transactionId: tx.id, money: tx.money, at };
    const entry = direction === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
    return { type: 'processed', entry, reference };
  }

  static referenceViolation(
    tx: WagerTransaction,
    ref: WagerTransaction,
    alreadyReversed: boolean,
  ): FailureCode | undefined {
    if (ref.status !== WagerTransactionStatus.Processed) {
      return FailureCode.ReferenceNotProcessed;
    }
    const allowed = ALLOWED_REFERENCE_KINDS[tx.kind] ?? [];
    if (!allowed.includes(ref.kind)) {
      return FailureCode.ReferenceInvalidKind;
    }
    const sameScope =
      ref.providerId === tx.providerId &&
      ref.playerId === tx.playerId &&
      ref.walletId === tx.walletId &&
      ref.money.currency === tx.money.currency &&
      ref.roundId === tx.roundId;
    if (!sameScope) {
      return FailureCode.ReferenceMismatch;
    }
    if (tx.isReversal()) {
      if (!ref.money.equals(tx.money)) {
        return FailureCode.ReferenceAmountMismatch;
      }
      if (alreadyReversed) {
        return FailureCode.ReferenceAlreadyReversed;
      }
    }
    return undefined;
  }
}
