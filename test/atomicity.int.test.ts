import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import { CreateWalletUseCase } from '../src/application/create-wallet.use-case';
import { noopInstrumentation } from '../src/application/instrumentation';
import { systemClock, TransactionalRepositories, UnitOfWork } from '../src/application/ports';
import { SubmitWagerTransactionUseCase } from '../src/application/submit-wager-transaction.use-case';
import { WagerProcessor } from '../src/application/wager-processor';
import { WagerTransactionKind } from '../src/domain/wager/wager-transaction';
import { mikroOrmConfig } from '../src/infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from '../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { ledgerInvariantViolations, resetDatabase, sql, TEST_DATABASE_URL, wagerBody } from './support/harness';

/**
 * Inbox, transação, saldo, ledger e outbox participam da MESMA transação SQL:
 * ou tudo é confirmado junto, ou nada. A falha é injetada no último passo
 * (gravação do outbox), depois que todo o resto já foi escrito no banco real.
 */

let orm: MikroORM;
let uow: MikroOrmUnitOfWork;
const policy = { baseDelayMs: 1000, maxDelayMs: 1000, maxAttempts: 3 };

/** Unit of Work real cujo outbox falha ao gravar: simula queda no meio da transação. */
class FailingOutboxUnitOfWork implements UnitOfWork {
  constructor(private readonly inner: UnitOfWork) {}
  get read() {
    return this.inner.read;
  }
  run<T>(work: (repos: TransactionalRepositories) => Promise<T>): Promise<T> {
    return this.inner.run((repos) =>
      work({
        ...repos,
        outbox: {
          ...repos.outbox,
          enqueue: async () => {
            throw new Error('falha simulada ao gravar o outbox');
          },
        },
      }),
    );
  }
}

async function counts(walletId: string, messageId: string) {
  const [row] = await sql`
    select (select balance::text from wallets where id = ${walletId}) as balance,
           (select version from wallets where id = ${walletId}) as version,
           (select count(*)::int from wager_transactions where wallet_id = ${walletId} and kind <> 'OPENING') as transactions,
           (select count(*)::int from ledger_entries where wallet_id = ${walletId}) as ledger,
           (select count(*)::int from inbox_messages where message_id = ${messageId}) as inbox,
           (select count(*)::int from outbox_messages where payload->'data'->>'walletId' = ${walletId}) as outbox`;
  return row;
}

beforeAll(async () => {
  await resetDatabase();
  orm = await MikroORM.init(mikroOrmConfig(TEST_DATABASE_URL, 5));
  uow = new MikroOrmUnitOfWork(orm, 2000);
});

afterAll(async () => {
  expect(await ledgerInvariantViolations()).toEqual([]);
  await orm?.close(true);
});

describe('atomicidade entre wallet, ledger, inbox e outbox', () => {
  test('falha no último passo desfaz tudo: nenhuma escrita parcial', async () => {
    const wallet = await new CreateWalletUseCase(uow, systemClock, noopInstrumentation).execute(
      { playerId: randomUUID(), initialBalance: { amount: '100.00', currency: 'BRL' } },
      'c',
    );
    const before = await counts(wallet.id, 'm-falha');

    const failing = new SubmitWagerTransactionUseCase(
      new FailingOutboxUnitOfWork(uow),
      new WagerProcessor(policy, noopInstrumentation),
      systemClock,
      noopInstrumentation,
    );
    const body = wagerBody({ playerId: wallet.playerId, walletId: wallet.id, kind: 'BET', amount: '40.00' });
    const cmd = { ...body, kind: body.kind as WagerTransactionKind, idempotencyKey: `${body.providerId}:${body.externalTransactionId}` };
    const ctx = { source: 'sqs' as const, correlationId: 'c', inbox: { consumerName: 'test', messageId: 'm-falha', payloadHash: 'a'.repeat(64) } };

    await expect(failing.execute(cmd, ctx)).rejects.toThrow('falha simulada');
    expect(await counts(wallet.id, 'm-falha')).toEqual(before);
    expect(before).toMatchObject({ balance: '100.00', version: 1, transactions: 0, ledger: 1, inbox: 0 });

    // A mesma mensagem, reprocessada sem a falha, é aplicada por inteiro (o inbox não ficou "sujo").
    const ok = new SubmitWagerTransactionUseCase(uow, new WagerProcessor(policy, noopInstrumentation), systemClock, noopInstrumentation);
    const result = await ok.execute(cmd, ctx);
    expect(result).toMatchObject({ status: 'PROCESSED', idempotentReplay: false, balance: { amount: '60.00' } });
    expect(await counts(wallet.id, 'm-falha')).toEqual({
      balance: '60.00',
      version: 2,
      transactions: 1,
      ledger: 2,
      inbox: 1,
      outbox: before.outbox + 2, // WagerTransactionProcessed + WalletBalanceChanged
    });
  });

  test('criação de wallet: wallet, OPENING, lançamento e eventos são atômicos', async () => {
    const failing = new CreateWalletUseCase(new FailingOutboxUnitOfWork(uow), systemClock, noopInstrumentation);
    const playerId = randomUUID();
    await expect(failing.execute({ playerId, initialBalance: { amount: '10.00', currency: 'BRL' } }, 'c')).rejects.toThrow('falha simulada');
    const [row] = await sql`select count(*)::int as n from wallets where player_id = ${playerId}`;
    expect(row.n).toBe(0);
  });
});
