import { LockMode } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import {
  InboxRepository,
  LedgerPage,
  LedgerRepository,
  OutboxRepository,
  ReconciliationSnapshot,
  TransactionalRepositories,
  WagerTransactionRepository,
  WalletRepository,
} from '../../application/ports';
import { ConcurrencyConflictError } from '../../application/errors';
import { InboxMessage } from '../../domain/messaging/inbox-message';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import { Money } from '../../domain/money/money';
import { WagerTransaction, WagerTransactionStatus } from '../../domain/wager/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import {
  InboxMapper,
  LedgerEntryMapper,
  OutboxMapper,
  OutboxRow,
  WagerTransactionMapper,
  WalletMapper,
} from './mappers';
import {
  InboxMessageRecord,
  LedgerEntryRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletRecord,
} from './records';

/**
 * Escritas são explícitas (em.insert / em.nativeUpdate) em vez de flush
 * implícito da Unit of Work: a ordem dos comandos importa para os triggers
 * (wallet atualizada antes do lançamento) e o UPDATE condicionado à versão
 * fica visível no código. Leituras não usam identity map compartilhado:
 * cada transação trabalha num fork próprio do EntityManager.
 */

class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<Wallet | undefined> {
    const r = await this.em.findOne(WalletRecord, { id }, { disableIdentityMap: true });
    return r ? WalletMapper.toDomain(r) : undefined;
  }

  async lockById(id: string): Promise<Wallet | undefined> {
    const r = await this.em.findOne(
      WalletRecord,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE, disableIdentityMap: true },
    );
    return r ? WalletMapper.toDomain(r) : undefined;
  }

  async findByPlayer(playerId: string, currency: string): Promise<Wallet | undefined> {
    const r = await this.em.findOne(WalletRecord, { playerId, currency }, { disableIdentityMap: true });
    return r ? WalletMapper.toDomain(r) : undefined;
  }

  async insert(wallet: Wallet): Promise<void> {
    await this.em.insert(WalletRecord, WalletMapper.toRecord(wallet));
  }

  async saveBalance(wallet: Wallet, expectedVersion: number): Promise<void> {
    const affected = await this.em.nativeUpdate(
      WalletRecord,
      { id: wallet.id, version: expectedVersion },
      { balance: wallet.balance.amount, version: wallet.version, updatedAt: wallet.updatedAt },
    );
    if (affected !== 1) {
      throw new ConcurrencyConflictError(`Wallet ${wallet.id} mudou de versão (esperada ${expectedVersion})`);
    }
  }
}

class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  private async one(where: Partial<WagerTransactionRecord>): Promise<WagerTransaction | undefined> {
    const r = await this.em.findOne(WagerTransactionRecord, where, { disableIdentityMap: true });
    return r ? WagerTransactionMapper.toDomain(r) : undefined;
  }

  findById(id: string) {
    return this.one({ id });
  }

  findByIdempotencyKey(idempotencyKey: string) {
    return this.one({ idempotencyKey });
  }

  findByExternalId(providerId: string, externalTransactionId: string) {
    return this.one({ providerId, externalTransactionId });
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionRecord, {
      referenceTransactionId,
      status: WagerTransactionStatus.Processed,
      kind: { $in: ['REFUND', 'ROLLBACK'] },
    });
    return count > 0;
  }

  async insert(tx: WagerTransaction): Promise<void> {
    await this.em.insert(WagerTransactionRecord, WagerTransactionMapper.toRecord(tx));
  }

  async updateStatus(tx: WagerTransaction, previousStatus: string): Promise<void> {
    const r = WagerTransactionMapper.toRecord(tx);
    const affected = await this.em.nativeUpdate(
      WagerTransactionRecord,
      { id: tx.id, status: previousStatus },
      {
        status: r.status,
        failureCode: r.failureCode,
        resultBalance: r.resultBalance,
        referenceTransactionId: r.referenceTransactionId,
        referenceAttempts: r.referenceAttempts,
        nextReferenceAttemptAt: r.nextReferenceAttemptAt,
        processedAt: r.processedAt,
        updatedAt: r.updatedAt,
      },
    );
    if (affected !== 1) {
      throw new ConcurrencyConflictError(`Transação ${tx.id} mudou de status (esperado ${previousStatus})`);
    }
  }

  async findDuePendingReferences(now: Date, limit: number) {
    const rows = await this.em.find(
      WagerTransactionRecord,
      { status: WagerTransactionStatus.PendingReference, nextReferenceAttemptAt: { $lte: now } },
      { fields: ['id', 'walletId'], orderBy: { nextReferenceAttemptAt: 'asc' }, limit, disableIdentityMap: true },
    );
    return rows.map((r) => ({ id: r.id, walletId: r.walletId }));
  }
}

class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(LedgerEntryRecord, LedgerEntryMapper.toRecord(entry));
  }

  async page(walletId: string, afterVersion: number, limit: number): Promise<LedgerPage> {
    const rows = await this.em.find(
      LedgerEntryRecord,
      { walletId, walletVersion: { $gt: afterVersion } },
      { orderBy: { walletVersion: 'asc' }, limit: limit + 1, disableIdentityMap: true },
    );
    const hasMore = rows.length > limit;
    const entries = rows.slice(0, limit).map((r) => LedgerEntryMapper.toDomain(r));
    return { entries, hasMore, lastVersion: entries.at(-1)?.walletVersion };
  }

  async reconcile(walletId: string): Promise<ReconciliationSnapshot | undefined> {
    // Uma única instrução SQL: wallet e soma do ledger vêm do mesmo snapshot.
    const rows = await this.em.execute<
      { balance: string; currency: string; calculated: string; entries: string }[]
    >(
      `select w.balance::text as balance, w.currency,
              coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)::text as calculated,
              count(l.id)::text as entries
         from wallets w
         left join ledger_entries l on l.wallet_id = w.id
        where w.id = ?
        group by w.id`,
      [walletId],
    );
    const row = rows[0];
    if (!row) return undefined;
    return {
      storedBalance: Money.fromPersisted(row.balance, row.currency),
      calculatedBalance: Money.fromPersisted(row.calculated, row.currency),
      checkedEntries: Number(row.entries),
    };
  }
}

class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async tryRegister(m: InboxMessage): Promise<boolean> {
    const rows = await this.em.execute<{ message_id: string }[]>(
      `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at)
       values (?, ?, ?, ?)
       on conflict (consumer_name, message_id) do nothing
       returning message_id`,
      [m.consumerName, m.messageId, m.payloadHash, m.receivedAt],
    );
    return rows.length === 1;
  }

  async find(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const r = await this.em.findOne(InboxMessageRecord, { consumerName, messageId }, { disableIdentityMap: true });
    return r ? InboxMapper.toDomain(r) : undefined;
  }

  async markProcessed(m: InboxMessage): Promise<void> {
    await this.em.nativeUpdate(
      InboxMessageRecord,
      { consumerName: m.consumerName, messageId: m.messageId },
      { processedAt: m.processedAt },
    );
  }
}

class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async enqueue(messages: OutboxMessage[]): Promise<void> {
    if (messages.length === 0) return;
    await this.em.insertMany(
      OutboxMessageRecord,
      messages.map((m) => OutboxMapper.toRecord(m)),
    );
  }

  async claimDue(owner: string, limit: number, leaseMs: number, now: Date): Promise<OutboxMessage[]> {
    // SKIP LOCKED: publishers concorrentes pegam lotes disjuntos sem esperar.
    // O lease (locked_until) protege contra um publisher que morreu depois de
    // reivindicar: quando expira, outro publisher pode reivindicar de novo.
    const rows = await this.em.execute<OutboxRow[]>(
      `update outbox_messages o
          set locked_by = ?, locked_until = ?
        where o.id in (
          select id from outbox_messages
           where published_at is null
             and next_attempt_at <= ?
             and (locked_until is null or locked_until < ?)
           order by next_attempt_at, occurred_at, id
           limit ?
           for update skip locked)
      returning o.*`,
      [owner, new Date(now.getTime() + leaseMs), now, now, limit],
    );
    return rows
      .map((r) => OutboxMapper.fromRow(r))
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.id.localeCompare(b.id));
  }

  async markPublished(m: OutboxMessage, owner: string): Promise<boolean> {
    const affected = await this.em.nativeUpdate(
      OutboxMessageRecord,
      { id: m.id, lockedBy: owner, publishedAt: null },
      { publishedAt: m.publishedAt, lockedBy: null, lockedUntil: null },
    );
    return affected === 1;
  }

  async scheduleRetry(m: OutboxMessage, owner: string): Promise<void> {
    await this.em.nativeUpdate(
      OutboxMessageRecord,
      { id: m.id, lockedBy: owner, publishedAt: null },
      { attempts: m.attempts, nextAttemptAt: m.nextAttemptAt, lockedBy: null, lockedUntil: null },
    );
  }

  async stats(now: Date) {
    const rows = await this.em.execute<{ pending: string; oldest: Date | string | null }[]>(
      `select count(*)::text as pending, min(occurred_at) as oldest from outbox_messages where published_at is null`,
    );
    const row = rows[0]!;
    const oldest = row.oldest ? new Date(row.oldest) : undefined;
    return {
      pending: Number(row.pending),
      oldestPendingAgeSeconds: oldest ? Math.max(0, (now.getTime() - oldest.getTime()) / 1000) : 0,
    };
  }
}

export function repositoriesFor(em: EntityManager): TransactionalRepositories {
  return {
    wallets: new MikroOrmWalletRepository(em),
    transactions: new MikroOrmWagerTransactionRepository(em),
    ledger: new MikroOrmLedgerRepository(em),
    inbox: new MikroOrmInboxRepository(em),
    outbox: new MikroOrmOutboxRepository(em),
  };
}
