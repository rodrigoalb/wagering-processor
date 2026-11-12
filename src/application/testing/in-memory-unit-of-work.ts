import { InboxMessage } from '../../domain/messaging/inbox-message';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import { WagerTransaction, WagerTransactionStatus } from '../../domain/wager/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import { ConcurrencyConflictError } from '../errors';
import { TransactionalRepositories, UnitOfWork } from '../ports';

/**
 * Unit of Work em memória, SOMENTE para testes unitários dos casos de uso.
 * Não substitui os testes de integração: concorrência, constraints e
 * atomicidade de verdade são provadas contra o PostgreSQL em test/.
 *
 * `run` desfaz as escritas se o trabalho lançar, imitando o rollback.
 */
export class InMemoryUnitOfWork implements UnitOfWork {
  wallets = new Map<string, Wallet>();
  transactions: WagerTransaction[] = [];
  ledger: WalletLedgerEntry[] = [];
  inbox = new Map<string, InboxMessage>();
  outbox: OutboxMessage[] = [];

  get read(): TransactionalRepositories {
    return this.repositories();
  }

  async run<T>(work: (repos: TransactionalRepositories) => Promise<T>): Promise<T> {
    const snapshot = {
      wallets: new Map(this.wallets),
      transactions: [...this.transactions],
      ledger: [...this.ledger],
      inbox: new Map(this.inbox),
      outbox: [...this.outbox],
    };
    try {
      return await work(this.repositories());
    } catch (err) {
      Object.assign(this, snapshot);
      throw err;
    }
  }

  addWallet(wallet: Wallet): void {
    this.wallets.set(wallet.id, wallet);
  }

  private copy(w: Wallet): Wallet {
    return Wallet.rehydrate({
      id: w.id,
      playerId: w.playerId,
      currency: w.currency,
      balance: w.balance,
      version: w.version,
      createdAt: w.createdAt,
      updatedAt: w.updatedAt,
    });
  }

  private repositories(): TransactionalRepositories {
    const find = (id: string) => {
      const w = this.wallets.get(id);
      return w ? this.copy(w) : undefined;
    };
    return {
      wallets: {
        findById: async (id) => find(id),
        lockById: async (id) => find(id),
        findByPlayer: async (playerId, currency) => {
          const w = [...this.wallets.values()].find((x) => x.playerId === playerId && x.currency === currency);
          return w ? this.copy(w) : undefined;
        },
        insert: async (w) => void this.wallets.set(w.id, this.copy(w)),
        saveBalance: async (w, expectedVersion) => {
          if (this.wallets.get(w.id)?.version !== expectedVersion) {
            throw new ConcurrencyConflictError('versão alterada');
          }
          this.wallets.set(w.id, this.copy(w));
        },
      },
      transactions: {
        findById: async (id) => this.transactions.find((t) => t.id === id),
        findByIdempotencyKey: async (key) => this.transactions.find((t) => t.idempotencyKey === key),
        findByExternalId: async (providerId, ext) =>
          this.transactions.find((t) => t.providerId === providerId && t.externalTransactionId === ext),
        hasProcessedReversal: async (referenceId) =>
          this.transactions.some(
            (t) => t.referenceTransactionId === referenceId && t.isReversal() && t.status === WagerTransactionStatus.Processed,
          ),
        insert: async (t) => void this.transactions.push(t),
        updateStatus: async () => undefined, // o objeto já foi alterado em memória
        findDuePendingReferences: async (now, limit) =>
          this.transactions
            .filter((t) => t.status === WagerTransactionStatus.PendingReference && t.nextReferenceAttemptAt! <= now)
            .slice(0, limit)
            .map((t) => ({ id: t.id, walletId: t.walletId })),
      },
      ledger: {
        insert: async (e) => void this.ledger.push(e),
        page: async () => ({ entries: [], hasMore: false }),
        reconcile: async () => undefined,
      },
      inbox: {
        tryRegister: async (m) => {
          const key = `${m.consumerName}:${m.messageId}`;
          if (this.inbox.has(key)) return false;
          this.inbox.set(key, m);
          return true;
        },
        find: async (consumerName, messageId) => this.inbox.get(`${consumerName}:${messageId}`),
        markProcessed: async () => undefined,
      },
      outbox: {
        enqueue: async (messages) => void this.outbox.push(...messages),
        claimDue: async () => [],
        markPublished: async () => true,
        scheduleRetry: async () => undefined,
        stats: async () => ({ pending: this.outbox.length, oldestPendingAgeSeconds: 0 }),
      },
    };
  }
}
