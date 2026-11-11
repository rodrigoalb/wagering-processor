import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Money } from '../src/domain/money/money';
import { migrate } from '../src/infrastructure/persistence/migrate';
import { ledgerInvariantViolations, resetDatabase, sql, TEST_DATABASE_URL } from './support/harness';

/**
 * As garantias de unicidade, imutabilidade e não negatividade estão no banco.
 * Estes testes falam SQL direto, sem passar pela aplicação: se o código tiver
 * um bug, o banco ainda segura.
 */

const now = new Date().toISOString();

async function insertWallet(balance = '0.00', version = 1, player = randomUUID(), currency = 'BRL') {
  const id = randomUUID();
  await sql`insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
            values (${id}, ${player}, ${currency}, ${balance}, ${version}, ${now}, ${now})`;
  return { id, player };
}

async function insertTx(walletId: string, player: string, over: Record<string, unknown> = {}) {
  const id = randomUUID();
  const ext = `ext-${id}`;
  const row = {
    id,
    provider_id: 'p',
    external_transaction_id: ext,
    idempotency_key: `p:${ext}`,
    payload_hash: 'a'.repeat(64),
    wallet_id: walletId,
    player_id: player,
    round_id: 'r',
    game_id: 'g',
    kind: 'BET',
    amount: '10.00',
    currency: 'BRL',
    status: 'PROCESSED',
    result_balance: '0.00',
    correlation_id: 'c',
    created_at: now,
    updated_at: now,
    ...over,
  };
  await sql`insert into wager_transactions ${sql(row)}`;
  return id;
}

/** Credita via SQL respeitando as regras (wallet primeiro, depois o lançamento). */
async function creditInTx(walletId: string, player: string, amount: string) {
  await sql.begin(async (tx) => {
    const [w] = await tx`select balance::text, version from wallets where id = ${walletId} for update`;
    const txId = randomUUID();
    const ext = `ext-${txId}`;
    await tx`insert into wager_transactions ${sql({
      id: txId, provider_id: 'p', external_transaction_id: ext, idempotency_key: `p:${ext}`, payload_hash: 'a'.repeat(64),
      wallet_id: walletId, player_id: player, round_id: 'r', game_id: 'g', kind: 'WIN', amount, currency: 'BRL',
      status: 'PROCESSED', result_balance: '0.00', correlation_id: 'c', created_at: now, updated_at: now,
    })}`;
    await tx`update wallets set balance = balance + ${amount}::numeric, version = version + 1 where id = ${walletId}`;
    await tx`insert into ledger_entries ${sql({
      id: randomUUID(), wallet_id: walletId, transaction_id: txId, direction: 'CREDIT', amount, currency: 'BRL',
      balance_before: w.balance, balance_after: Money.fromPersisted(w.balance, 'BRL').add(Money.from({ amount, currency: 'BRL' })).amount,
      wallet_version: w.version + 1, created_at: now,
    })}`;
  });
}

beforeAll(resetDatabase);
afterAll(async () => {
  expect(await ledgerInvariantViolations()).toEqual([]);
  await resetDatabase();
});

describe('migrations', () => {
  test('são reversíveis: down remove tudo e up recria', async () => {
    await migrate('down', TEST_DATABASE_URL);
    const [{ n }] = await sql`select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_name = 'wallets'`;
    await expect(n).toBe(0);
    await migrate('up', TEST_DATABASE_URL);
    const tables = await sql`select table_name from information_schema.tables where table_schema = 'public' order by 1`;
    await expect(tables.map((t: { table_name: string }) => t.table_name)).toEqual([
      'inbox_messages',
      'ledger_entries',
      'mikro_orm_migrations',
      'outbox_messages',
      'wager_transactions',
      'wallets',
    ]);
  });
});

describe('wallets', () => {
  test('saldo negativo é recusado pelo banco', async () => {
    await expect(insertWallet('-0.01')).rejects.toThrow(/check/i);
  });

  test('uma wallet por (player, moeda)', async () => {
    const { player } = await insertWallet();
    await expect(insertWallet('0.00', 1, player)).rejects.toThrow(/wallets_player_currency_unique/);
    await insertWallet('0.00', 1, player, 'USD'); // outra moeda é permitida
  });

  test('mudar saldo sem lançamento no ledger falha no commit', async () => {
    const { id } = await insertWallet();
    await expect(sql`update wallets set balance = 50, version = 2 where id = ${id}`).rejects.toThrow(/sem lançamento correspondente/);
  });

  test('version só muda com o saldo e sempre +1', async () => {
    const { id } = await insertWallet();
    await expect(sql`update wallets set version = 5 where id = ${id}`).rejects.toThrow(/version só muda/);
    await expect(sql`update wallets set balance = 1, version = 3 where id = ${id}`).rejects.toThrow(/version \+ 1/);
  });

  test('player e moeda são imutáveis; DELETE é proibido', async () => {
    const { id } = await insertWallet();
    await expect(sql`update wallets set currency = 'USD' where id = ${id}`).rejects.toThrow(/imutáveis/);
    await expect(sql`delete from wallets where id = ${id}`).rejects.toThrow(/DELETE não é permitido/);
  });

  test('crédito correto (wallet + lançamento na mesma transação) passa', async () => {
    const { id, player } = await insertWallet();
    await creditInTx(id, player, '12.34');
    const [w] = await sql`select balance::text, version from wallets where id = ${id}`;
    await expect(w).toEqual({ balance: '12.34', version: 2 });
  });
});

describe('ledger_entries', () => {
  test('UPDATE, DELETE e TRUNCATE são bloqueados (append-only)', async () => {
    const { id, player } = await insertWallet();
    await creditInTx(id, player, '1.00');
    await expect(sql`update ledger_entries set amount = 2 where wallet_id = ${id}`).rejects.toThrow(/append-only/);
    await expect(sql`delete from ledger_entries where wallet_id = ${id}`).rejects.toThrow(/append-only/);
    await expect(sql`truncate ledger_entries cascade`).rejects.toThrow(/append-only/);
  });

  test('aritmética desbalanceada é recusada', async () => {
    // Wallet e lançamento coerentes entre si (passa no trigger), mas 0 + 10 != 9.
    await expect(
      sql.begin(async (tx) => {
        const id = randomUUID();
        const player = randomUUID();
        await tx`insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
                 values (${id}, ${player}, 'BRL', '9.00', 1, ${now}, ${now})`;
        const txId = randomUUID();
        await tx`insert into wager_transactions ${sql({
          id: txId, provider_id: 'p', external_transaction_id: `e-${txId}`, idempotency_key: `k-${txId}`, payload_hash: 'a'.repeat(64),
          wallet_id: id, player_id: player, round_id: 'r', game_id: 'g', kind: 'WIN', amount: '10.00', currency: 'BRL',
          status: 'PROCESSED', result_balance: '9.00', correlation_id: 'c', created_at: now, updated_at: now,
        })}`;
        await tx`insert into ledger_entries ${sql({
          id: randomUUID(), wallet_id: id, transaction_id: txId, direction: 'CREDIT', amount: '10.00', currency: 'BRL',
          balance_before: '0.00', balance_after: '9.00', wallet_version: 1, created_at: now,
        })}`;
      }),
    ).rejects.toThrow(/ledger_entries_balanced/);
  });

  test('lançamento que não bate com o estado da wallet é recusado', async () => {
    const { id, player } = await insertWallet('0.00');
    const txId = await insertTx(id, player);
    await expect(
      sql`insert into ledger_entries ${sql({
        id: randomUUID(), wallet_id: id, transaction_id: txId, direction: 'CREDIT', amount: '10.00', currency: 'BRL',
        balance_before: '0.00', balance_after: '10.00', wallet_version: 2, created_at: now,
      })}`,
    ).rejects.toThrow(/não bate com a wallet/);
  });
});

describe('wager_transactions', () => {
  test('(provider, external id) e idempotency_key são únicos', async () => {
    const { id, player } = await insertWallet();
    await insertTx(id, player, { external_transaction_id: 'dup', idempotency_key: 'k1' });
    await expect(insertTx(id, player, { external_transaction_id: 'dup', idempotency_key: 'k2' })).rejects.toThrow(/wager_transactions_external_unique/);
    await expect(insertTx(id, player, { external_transaction_id: 'other', idempotency_key: 'k1' })).rejects.toThrow(/wager_transactions_idempotency_key_unique/);
  });

  test('estado terminal não muda e campos de negócio são imutáveis', async () => {
    const { id, player } = await insertWallet();
    const txId = await insertTx(id, player, { status: 'PROCESSED' });
    await expect(sql`update wager_transactions set status = 'REJECTED', failure_code = 'X' where id = ${txId}`).rejects.toThrow(/estado terminal/);
    const pending = await insertTx(id, player, {
      status: 'PENDING_REFERENCE', kind: 'REFUND', reference_external_transaction_id: 'x', next_reference_attempt_at: now,
    });
    await expect(sql`update wager_transactions set amount = 99 where id = ${pending}`).rejects.toThrow(/imutáveis/);
    await expect(sql`delete from wager_transactions where id = ${pending}`).rejects.toThrow(/DELETE não é permitido/);
  });

  test('uma referência só pode ser revertida uma vez', async () => {
    const { id, player } = await insertWallet();
    const bet = await insertTx(id, player);
    await insertTx(id, player, { kind: 'REFUND', reference_external_transaction_id: 'b', reference_transaction_id: bet });
    await expect(
      insertTx(id, player, { kind: 'ROLLBACK', reference_external_transaction_id: 'b', reference_transaction_id: bet }),
    ).rejects.toThrow(/wager_transactions_one_reversal_per_reference/);
    // Uma reversão rejeitada não conta.
    await insertTx(id, player, {
      kind: 'REFUND', reference_external_transaction_id: 'b', reference_transaction_id: bet, status: 'REJECTED', failure_code: 'REFERENCE_ALREADY_REVERSED',
    });
  });

  test('REFUND/ROLLBACK sem referência e REJECTED sem failure_code são recusados', async () => {
    const { id, player } = await insertWallet();
    await expect(insertTx(id, player, { kind: 'REFUND' })).rejects.toThrow(/wager_transactions_reference_required/);
    await expect(insertTx(id, player, { status: 'REJECTED' })).rejects.toThrow(/wager_transactions_failure_code_iff_failed/);
  });
});

describe('inbox e outbox', () => {
  test('inbox é único por (consumer, messageId); eventId do outbox é único', async () => {
    await sql`insert into inbox_messages (consumer_name, message_id, payload_hash, received_at) values ('c', 'm1', ${'a'.repeat(64)}, now())`;
    await expect(sql`insert into inbox_messages (consumer_name, message_id, payload_hash, received_at) values ('c', 'm1', ${'a'.repeat(64)}, now())`).rejects.toThrow(/inbox_messages_pkey/);
    const payload = { eventId: 'e1' };
    await sql`insert into outbox_messages (id, aggregate_id, partition_key, event_type, payload, occurred_at, next_attempt_at) values (${randomUUID()}, 'a', 'a', 't', ${payload}, now(), now())`;
    await expect(
      sql`insert into outbox_messages (id, aggregate_id, partition_key, event_type, payload, occurred_at, next_attempt_at) values (${randomUUID()}, 'a', 'a', 't', ${payload}, now(), now())`,
    ).rejects.toThrow(/outbox_messages_event_id/);
  });
});
