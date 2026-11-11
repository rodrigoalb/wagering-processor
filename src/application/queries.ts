import { LedgerDirection } from '../domain/ledger/wallet-ledger-entry';
import { MoneyProps } from '../domain/money/money';
import { WagerTransaction } from '../domain/wager/wager-transaction';
import { InvalidCursorError, TransactionNotFoundError, WalletNotFoundError } from './errors';
import { Instrumentation } from './instrumentation';
import { UnitOfWork } from './ports';
import { toWalletView, WalletView } from './create-wallet.use-case';

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
  createdAt: string;
}

export interface LedgerPageView {
  items: LedgerEntryView[];
  nextCursor: string | null;
}

export interface TransactionView {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  status: string;
  failureCode: string | null;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  balance: MoneyProps | null;
  referenceAttempts: number;
  nextReferenceAttemptAt: string | null;
  createdAt: string;
  processedAt: string | null;
}

export interface ReconciliationView {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

/**
 * Cursor opaco e estável: base64url de {"v": walletVersion}. A versão é única
 * e crescente por wallet e lançamentos nunca são apagados, então a paginação
 * não pula nem repete itens mesmo com inserções concorrentes.
 */
export const LedgerCursor = {
  encode: (version: number) => Buffer.from(JSON.stringify({ v: version })).toString('base64url'),
  decode(cursor: string): number {
    try {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { v?: unknown };
      if (typeof parsed.v === 'number' && Number.isInteger(parsed.v) && parsed.v >= 0) return parsed.v;
    } catch {
      /* cai no erro abaixo */
    }
    throw new InvalidCursorError();
  },
};

export function toTransactionView(t: WagerTransaction): TransactionView {
  return {
    id: t.id,
    providerId: t.providerId,
    externalTransactionId: t.externalTransactionId,
    idempotencyKey: t.idempotencyKey,
    walletId: t.walletId,
    playerId: t.playerId,
    roundId: t.roundId,
    gameId: t.gameId,
    kind: t.kind,
    money: t.money.toJSON(),
    status: t.status,
    failureCode: t.failureCode ?? null,
    referenceExternalTransactionId: t.referenceExternalTransactionId ?? null,
    referenceTransactionId: t.referenceTransactionId ?? null,
    balance: t.resultBalance?.toJSON() ?? null,
    referenceAttempts: t.referenceAttempts,
    nextReferenceAttemptAt: t.nextReferenceAttemptAt?.toISOString() ?? null,
    createdAt: t.createdAt.toISOString(),
    processedAt: t.processedAt?.toISOString() ?? null,
  };
}

export class WalletQueries {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly instrumentation: Instrumentation,
  ) {}

  async getWallet(walletId: string): Promise<WalletView> {
    const wallet = await this.uow.read.wallets.findById(walletId);
    if (!wallet) throw new WalletNotFoundError(walletId);
    return toWalletView(wallet);
  }

  async getLedger(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPageView> {
    const after = cursor ? LedgerCursor.decode(cursor) : 0;
    const repos = this.uow.read;
    if (!(await repos.wallets.findById(walletId))) throw new WalletNotFoundError(walletId);
    const page = await repos.ledger.page(walletId, after, limit);
    return {
      items: page.entries.map((e) => ({
        id: e.id,
        transactionId: e.transactionId,
        direction: e.direction,
        money: e.money.toJSON(),
        balanceBefore: e.balanceBefore.toJSON(),
        balanceAfter: e.balanceAfter.toJSON(),
        walletVersion: e.walletVersion,
        createdAt: e.createdAt.toISOString(),
      })),
      nextCursor: page.hasMore && page.lastVersion !== undefined ? LedgerCursor.encode(page.lastVersion) : null,
    };
  }

  async getTransaction(transactionId: string): Promise<TransactionView> {
    const tx = await this.uow.read.transactions.findById(transactionId);
    if (!tx) throw new TransactionNotFoundError(transactionId);
    return toTransactionView(tx);
  }

  async getTransactionByExternalId(providerId: string, externalTransactionId: string): Promise<TransactionView> {
    const tx = await this.uow.read.transactions.findByExternalId(providerId, externalTransactionId);
    if (!tx) throw new TransactionNotFoundError(`${providerId}/${externalTransactionId}`);
    return toTransactionView(tx);
  }

  /**
   * Compara o saldo materializado com o saldo reconstruído pelo ledger. Não
   * corrige nada: divergência é logada, contada em métrica e devolvida.
   */
  async reconcile(walletId: string): Promise<ReconciliationView> {
    const snap = await this.uow.read.ledger.reconcile(walletId);
    if (!snap) throw new WalletNotFoundError(walletId);
    const difference = snap.storedBalance.subtract(snap.calculatedBalance);
    const consistent = difference.isZero();
    if (!consistent) {
      this.instrumentation.reconciliationMismatch(walletId, snap.storedBalance.amount, snap.calculatedBalance.amount);
    }
    return {
      walletId,
      storedBalance: snap.storedBalance.toJSON(),
      calculatedBalance: snap.calculatedBalance.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: snap.checkedEntries,
    };
  }
}
