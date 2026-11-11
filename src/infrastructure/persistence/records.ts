import { EntitySchema } from '@mikro-orm/core';

/**
 * Registros de persistência (linhas). São separados das classes de domínio de
 * propósito: o domínio não conhece decorators nem tipos do ORM, e a
 * reidratação passa sempre pelas factories `rehydrate` (ver mappers.ts).
 *
 * Dinheiro: colunas numeric(20,2) mapeadas como `decimal`, que o driver `pg`
 * entrega como string. Nunca passa por `number`.
 */

export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: string;
  amount!: string;
  currency!: string;
  referenceExternalTransactionId?: string | null;
  referenceTransactionId?: string | null;
  status!: string;
  failureCode?: string | null;
  resultBalance?: string | null;
  referenceAttempts!: number;
  nextReferenceAttemptAt?: Date | null;
  correlationId!: string;
  createdAt!: Date;
  updatedAt!: Date;
  processedAt?: Date | null;
}

export class LedgerEntryRecord {
  id!: string;
  walletId!: string;
  transactionId!: string;
  direction!: string;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  walletVersion!: number;
  createdAt!: Date;
}

export class InboxMessageRecord {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt?: Date | null;
}

export class OutboxMessageRecord {
  id!: string;
  aggregateId!: string;
  partitionKey!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt!: Date;
  publishedAt?: Date | null;
  lockedBy?: string | null;
  lockedUntil?: Date | null;
}

const money = { type: 'decimal', precision: 20, scale: 2 } as const;
const ts = { type: 'datetime', columnType: 'timestamptz' } as const;

export const WalletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'uuid' },
    currency: { type: 'string', length: 3 },
    balance: { ...money },
    version: { type: 'integer' },
    createdAt: { ...ts },
    updatedAt: { ...ts },
  },
});

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'string' },
    externalTransactionId: { type: 'string' },
    idempotencyKey: { type: 'string' },
    payloadHash: { type: 'string' },
    walletId: { type: 'uuid' },
    playerId: { type: 'uuid' },
    roundId: { type: 'string' },
    gameId: { type: 'string' },
    kind: { type: 'string' },
    amount: { ...money },
    currency: { type: 'string', length: 3 },
    referenceExternalTransactionId: { type: 'string', nullable: true },
    referenceTransactionId: { type: 'uuid', nullable: true },
    status: { type: 'string' },
    failureCode: { type: 'string', nullable: true },
    resultBalance: { ...money, nullable: true },
    referenceAttempts: { type: 'integer' },
    nextReferenceAttemptAt: { ...ts, nullable: true },
    correlationId: { type: 'string' },
    createdAt: { ...ts },
    updatedAt: { ...ts },
    processedAt: { ...ts, nullable: true },
  },
});

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRecord>({
  class: LedgerEntryRecord,
  tableName: 'ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid' },
    transactionId: { type: 'uuid' },
    direction: { type: 'string' },
    amount: { ...money },
    currency: { type: 'string', length: 3 },
    balanceBefore: { ...money },
    balanceAfter: { ...money },
    walletVersion: { type: 'integer' },
    createdAt: { ...ts },
  },
});

export const InboxMessageSchema = new EntitySchema<InboxMessageRecord>({
  class: InboxMessageRecord,
  tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'string', primary: true },
    messageId: { type: 'string', primary: true },
    payloadHash: { type: 'string' },
    receivedAt: { ...ts },
    processedAt: { ...ts, nullable: true },
  },
});

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
  class: OutboxMessageRecord,
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { type: 'string' },
    partitionKey: { type: 'string' },
    eventType: { type: 'string' },
    payload: { type: 'json' },
    occurredAt: { ...ts },
    attempts: { type: 'integer' },
    nextAttemptAt: { ...ts },
    publishedAt: { ...ts, nullable: true },
    lockedBy: { type: 'string', nullable: true },
    lockedUntil: { ...ts, nullable: true },
  },
});

export const ALL_SCHEMAS = [
  WalletSchema,
  WagerTransactionSchema,
  LedgerEntrySchema,
  InboxMessageSchema,
  OutboxMessageSchema,
];
