import { InboxMessage } from '../domain/messaging/inbox-message';
import { OutboxMessage } from '../domain/messaging/outbox-message';
import { WalletLedgerEntry } from '../domain/ledger/wallet-ledger-entry';
import { Money } from '../domain/money/money';
import { WagerTransaction } from '../domain/wager/wager-transaction';
import { Wallet } from '../domain/wallet/wallet';

/**
 * Portas de persistência. A aplicação só conhece estas interfaces; a
 * implementação (MikroORM + PostgreSQL) fica em infrastructure/persistence.
 */

export interface WalletRepository {
  findById(id: string): Promise<Wallet | undefined>;
  /** SELECT ... FOR UPDATE: trava somente a linha desta wallet até o fim da transação. */
  lockById(id: string): Promise<Wallet | undefined>;
  findByPlayer(playerId: string, currency: string): Promise<Wallet | undefined>;
  insert(wallet: Wallet): Promise<void>;
  /**
   * UPDATE condicionado: só grava se a versão no banco ainda for `expectedVersion`.
   * Lança ConcurrencyConflictError se nenhuma linha for afetada.
   */
  saveBalance(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(key: string): Promise<WagerTransaction | undefined>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  /** Existe REFUND ou ROLLBACK PROCESSED apontando para esta transação? */
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  insert(tx: WagerTransaction): Promise<void>;
  /** Persiste a transição de status; condicionado ao status anterior. */
  updateStatus(tx: WagerTransaction, previousStatus: string): Promise<void>;
  /** Transações em PENDING_REFERENCE vencidas, mais antigas primeiro. */
  findDuePendingReferences(now: Date, limit: number): Promise<{ id: string; walletId: string }[]>;
}

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  /** walletVersion do último item, para continuar a paginação. */
  lastVersion?: number;
  hasMore: boolean;
}

export interface ReconciliationSnapshot {
  storedBalance: Money;
  calculatedBalance: Money;
  checkedEntries: number;
}

export interface LedgerRepository {
  insert(entry: WalletLedgerEntry): Promise<void>;
  page(walletId: string, afterVersion: number, limit: number): Promise<LedgerPage>;
  /** Saldo materializado e saldo reconstruído pelo ledger, lidos no mesmo snapshot. */
  reconcile(walletId: string): Promise<ReconciliationSnapshot | undefined>;
}

export interface InboxRepository {
  /**
   * INSERT ... ON CONFLICT DO NOTHING. Retorna false se a mensagem já existe.
   * Uma inserção concorrente da mesma chave espera o commit da outra.
   */
  tryRegister(message: InboxMessage): Promise<boolean>;
  find(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
  markProcessed(message: InboxMessage): Promise<void>;
}

export interface ClaimedOutboxMessage {
  message: OutboxMessage;
  leaseOwner: string;
}

export interface OutboxRepository {
  enqueue(messages: OutboxMessage[]): Promise<void>;
  /** Reivindica mensagens vencidas com lease (FOR UPDATE SKIP LOCKED); outro publisher não as vê até o lease expirar. */
  claimDue(owner: string, limit: number, leaseMs: number, now: Date): Promise<OutboxMessage[]>;
  markPublished(message: OutboxMessage, owner: string): Promise<boolean>;
  scheduleRetry(message: OutboxMessage, owner: string): Promise<void>;
  stats(now: Date): Promise<{ pending: number; oldestPendingAgeSeconds: number }>;
}

/** Repositórios ligados à mesma transação SQL. */
export interface TransactionalRepositories {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

export interface UnitOfWork {
  /** Executa `work` dentro de uma transação. Commit se resolver, rollback se lançar. */
  run<T>(work: (repos: TransactionalRepositories) => Promise<T>): Promise<T>;
  /** Repositórios fora de transação, para leituras. */
  readonly read: TransactionalRepositories;
}

export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');

export interface Clock {
  now(): Date;
}

export const CLOCK = Symbol('CLOCK');

export const systemClock: Clock = { now: () => new Date() };
