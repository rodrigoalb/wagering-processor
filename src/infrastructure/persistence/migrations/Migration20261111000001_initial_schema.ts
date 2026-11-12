import { Migration } from '@mikro-orm/migrations';

/**
 * Schema inicial. As garantias de unicidade, imutabilidade e não negatividade
 * vivem aqui, no banco, e não só no código (seção 5, item 9 do desafio).
 *
 * Resumo do que o banco garante sozinho:
 *  - wallets: saldo >= 0; uma por (player_id, currency); version só muda junto
 *    com o saldo e sempre +1; player/moeda imutáveis; sem DELETE.
 *  - wager_transactions: (provider_id, external_transaction_id) e
 *    idempotency_key únicos; status terminal não muda; campos de negócio
 *    imutáveis; no máximo uma reversão PROCESSED por referência; sem DELETE.
 *  - ledger_entries: append-only (UPDATE/DELETE/TRUNCATE bloqueados);
 *    aritmética before ± amount = after; um lançamento por (wallet, transação);
 *    cadeia de versões única por wallet; o lançamento precisa bater com o
 *    estado atual da wallet.
 *  - wallets x ledger: trigger de constraint DEFERRED verifica no commit que
 *    toda mudança de saldo tem o lançamento correspondente.
 *  - inbox: PK (consumer_name, message_id). outbox: eventId único.
 */
export class Migration20261111000001_initial_schema extends Migration {
  override async up(): Promise<void> {
    // ------------------------------------------------------------------ wallets
    this.addSql(`
      create table wallets (
        id          uuid primary key,
        player_id   uuid not null,
        currency    char(3) not null check (currency ~ '^[A-Z]{3}$'),
        balance     numeric(20,2) not null check (balance >= 0),
        version     integer not null check (version >= 1),
        created_at  timestamptz not null,
        updated_at  timestamptz not null,
        constraint wallets_player_currency_unique unique (player_id, currency)
      );
    `);

    this.addSql(`
      create function wallets_guard_update() returns trigger language plpgsql as $$
      begin
        if new.id <> old.id or new.player_id <> old.player_id or new.currency <> old.currency
           or new.created_at <> old.created_at then
          raise exception 'wallets: id, player_id, currency e created_at são imutáveis'
            using errcode = 'check_violation';
        end if;
        if new.balance <> old.balance and new.version <> old.version + 1 then
          raise exception 'wallets: mudança de saldo exige version = version + 1'
            using errcode = 'check_violation';
        end if;
        if new.balance = old.balance and new.version <> old.version then
          raise exception 'wallets: version só muda quando o saldo muda'
            using errcode = 'check_violation';
        end if;
        return new;
      end $$;
    `);
    this.addSql(`create trigger wallets_guard_update before update on wallets for each row execute function wallets_guard_update();`);

    this.addSql(`
      create function forbid_delete() returns trigger language plpgsql as $$
      begin
        raise exception '%: DELETE não é permitido', tg_table_name using errcode = 'restrict_violation';
      end $$;
    `);
    this.addSql(`create trigger wallets_forbid_delete before delete on wallets for each row execute function forbid_delete();`);

    // ------------------------------------------------------- wager_transactions
    this.addSql(`
      create table wager_transactions (
        id                                 uuid primary key,
        provider_id                        varchar(100) not null,
        external_transaction_id            varchar(200) not null,
        idempotency_key                    varchar(300) not null,
        payload_hash                       char(64) not null,
        wallet_id                          uuid not null references wallets(id),
        player_id                          uuid not null,
        round_id                           varchar(200) not null,
        game_id                            varchar(200) not null,
        kind                               varchar(16) not null
          check (kind in ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        amount                             numeric(20,2) not null check (amount >= 0),
        currency                           char(3) not null,
        reference_external_transaction_id  varchar(200),
        reference_transaction_id           uuid references wager_transactions(id),
        status                             varchar(20) not null
          check (status in ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        failure_code                       varchar(64),
        result_balance                     numeric(20,2) check (result_balance >= 0),
        reference_attempts                 integer not null default 0 check (reference_attempts >= 0),
        next_reference_attempt_at          timestamptz,
        correlation_id                     varchar(200) not null,
        created_at                         timestamptz not null,
        updated_at                         timestamptz not null,
        processed_at                       timestamptz,
        constraint wager_transactions_external_unique unique (provider_id, external_transaction_id),
        constraint wager_transactions_idempotency_key_unique unique (idempotency_key),
        constraint wager_transactions_reference_required
          check (kind not in ('REFUND','ROLLBACK') or reference_external_transaction_id is not null),
        constraint wager_transactions_failure_code_iff_failed
          check ((status in ('REJECTED','FAILED')) = (failure_code is not null)),
        constraint wager_transactions_pending_has_schedule
          check (status <> 'PENDING_REFERENCE' or next_reference_attempt_at is not null),
        constraint wager_transactions_positive_amount
          check (kind = 'LOSS' or amount > 0)
      );
    `);
    // Uma referência só pode ser revertida uma vez (REFUND ou ROLLBACK, ver ARCHITECTURE.md).
    this.addSql(`
      create unique index wager_transactions_one_reversal_per_reference
        on wager_transactions (reference_transaction_id)
        where status = 'PROCESSED' and kind in ('REFUND','ROLLBACK');
    `);
    // Apenas uma OPENING por wallet.
    this.addSql(`
      create unique index wager_transactions_one_opening_per_wallet
        on wager_transactions (wallet_id) where kind = 'OPENING';
    `);
    this.addSql(`
      create index wager_transactions_pending_due
        on wager_transactions (next_reference_attempt_at) where status = 'PENDING_REFERENCE';
    `);
    this.addSql(`create index wager_transactions_wallet on wager_transactions (wallet_id, created_at);`);

    this.addSql(`
      create function wager_transactions_guard_update() returns trigger language plpgsql as $$
      begin
        if old.status in ('PROCESSED','REJECTED','FAILED') then
          raise exception 'wager_transactions: transação % já está em estado terminal %', old.id, old.status
            using errcode = 'check_violation';
        end if;
        if (new.id, new.provider_id, new.external_transaction_id, new.idempotency_key, new.payload_hash,
            new.wallet_id, new.player_id, new.round_id, new.game_id, new.kind, new.amount, new.currency,
            new.reference_external_transaction_id, new.correlation_id, new.created_at)
           is distinct from
           (old.id, old.provider_id, old.external_transaction_id, old.idempotency_key, old.payload_hash,
            old.wallet_id, old.player_id, old.round_id, old.game_id, old.kind, old.amount, old.currency,
            old.reference_external_transaction_id, old.correlation_id, old.created_at) then
          raise exception 'wager_transactions: campos de negócio são imutáveis' using errcode = 'check_violation';
        end if;
        return new;
      end $$;
    `);
    this.addSql(`create trigger wager_transactions_guard_update before update on wager_transactions for each row execute function wager_transactions_guard_update();`);
    this.addSql(`create trigger wager_transactions_forbid_delete before delete on wager_transactions for each row execute function forbid_delete();`);

    // ----------------------------------------------------------- ledger_entries
    this.addSql(`
      create table ledger_entries (
        id              uuid primary key,
        wallet_id       uuid not null references wallets(id),
        transaction_id  uuid not null references wager_transactions(id),
        direction       varchar(6) not null check (direction in ('DEBIT','CREDIT')),
        amount          numeric(20,2) not null check (amount > 0),
        currency        char(3) not null,
        balance_before  numeric(20,2) not null check (balance_before >= 0),
        balance_after   numeric(20,2) not null check (balance_after >= 0),
        wallet_version  integer not null check (wallet_version >= 1),
        created_at      timestamptz not null,
        constraint ledger_entries_one_per_transaction unique (wallet_id, transaction_id),
        constraint ledger_entries_version_chain unique (wallet_id, wallet_version),
        constraint ledger_entries_balanced check (
          (direction = 'CREDIT' and balance_after = balance_before + amount) or
          (direction = 'DEBIT'  and balance_after = balance_before - amount)
        )
      );
    `);
    this.addSql(`
      create function ledger_entries_forbid_mutation() returns trigger language plpgsql as $$
      begin
        raise exception 'ledger_entries é append-only: % não é permitido', tg_op using errcode = 'restrict_violation';
      end $$;
    `);
    this.addSql(`create trigger ledger_entries_no_update_delete before update or delete on ledger_entries for each row execute function ledger_entries_forbid_mutation();`);
    this.addSql(`create trigger ledger_entries_no_truncate before truncate on ledger_entries for each statement execute function ledger_entries_forbid_mutation();`);

    // O lançamento precisa descrever exatamente o estado atual da wallet
    // (a wallet é atualizada antes, na mesma transação).
    this.addSql(`
      create function ledger_entries_match_wallet() returns trigger language plpgsql as $$
      declare w wallets%rowtype;
      begin
        select * into w from wallets where id = new.wallet_id;
        if w.balance <> new.balance_after or w.version <> new.wallet_version or w.currency <> new.currency then
          raise exception 'ledger_entries: lançamento (after=%, v=%) não bate com a wallet (balance=%, v=%)',
            new.balance_after, new.wallet_version, w.balance, w.version using errcode = 'check_violation';
        end if;
        return new;
      end $$;
    `);
    this.addSql(`create trigger ledger_entries_match_wallet before insert on ledger_entries for each row execute function ledger_entries_match_wallet();`);

    // No commit: todo saldo materializado tem o lançamento que o produziu.
    this.addSql(`
      create function wallets_require_ledger_entry() returns trigger language plpgsql as $$
      begin
        if tg_op = 'UPDATE' and new.balance = old.balance then
          return null;
        end if;
        if tg_op = 'INSERT' and new.balance = 0 then
          return null;
        end if;
        if not exists (
          select 1 from ledger_entries
           where wallet_id = new.id and wallet_version = new.version and balance_after = new.balance
        ) then
          raise exception 'wallets: saldo da wallet % (v=%) sem lançamento correspondente no ledger', new.id, new.version
            using errcode = 'check_violation';
        end if;
        return null;
      end $$;
    `);
    this.addSql(`
      create constraint trigger wallets_require_ledger_entry
        after insert or update on wallets deferrable initially deferred
        for each row execute function wallets_require_ledger_entry();
    `);

    // ------------------------------------------------------------------- inbox
    this.addSql(`
      create table inbox_messages (
        consumer_name  varchar(100) not null,
        message_id     varchar(200) not null,
        payload_hash   char(64) not null,
        received_at    timestamptz not null,
        processed_at   timestamptz,
        primary key (consumer_name, message_id)
      );
    `);

    // ------------------------------------------------------------------ outbox
    this.addSql(`
      create table outbox_messages (
        id               uuid primary key,
        aggregate_id     varchar(100) not null,
        partition_key    varchar(100) not null,
        event_type       varchar(100) not null,
        payload          jsonb not null,
        occurred_at      timestamptz not null,
        attempts         integer not null default 0 check (attempts >= 0),
        next_attempt_at  timestamptz not null,
        published_at     timestamptz,
        locked_by        varchar(100),
        locked_until     timestamptz
      );
    `);
    this.addSql(`create unique index outbox_messages_event_id on outbox_messages ((payload->>'eventId'));`);
    this.addSql(`create index outbox_messages_due on outbox_messages (next_attempt_at, occurred_at) where published_at is null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists outbox_messages;`);
    this.addSql(`drop table if exists inbox_messages;`);
    this.addSql(`drop trigger if exists wallets_require_ledger_entry on wallets;`);
    this.addSql(`drop table if exists ledger_entries;`);
    this.addSql(`drop table if exists wager_transactions;`);
    this.addSql(`drop table if exists wallets;`);
    this.addSql(`drop function if exists wallets_require_ledger_entry();`);
    this.addSql(`drop function if exists ledger_entries_match_wallet();`);
    this.addSql(`drop function if exists ledger_entries_forbid_mutation();`);
    this.addSql(`drop function if exists wager_transactions_guard_update();`);
    this.addSql(`drop function if exists forbid_delete();`);
    this.addSql(`drop function if exists wallets_guard_update();`);
  }
}
