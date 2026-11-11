import { WagerTransactionProcessed, WalletBalanceChanged } from '../domain/messaging/events';
import { IntegrationEvent } from '../domain/messaging/integration-event';
import { OutboxMessage } from '../domain/messaging/outbox-message';
import { Money, MoneyProps } from '../domain/money/money';
import { newId } from '../domain/shared/id';
import { WagerTransaction } from '../domain/wager/wager-transaction';
import { Wallet } from '../domain/wallet/wallet';
import { WalletAlreadyExistsError } from './errors';
import { Instrumentation } from './instrumentation';
import { canonicalJson, sha256Hex } from './payload-hash';
import { Clock, UnitOfWork } from './ports';
import { withConcurrencyRetry } from './retry';

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
}

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export const INTERNAL_PROVIDER = 'internal';

export function toWalletView(w: Wallet): WalletView {
  return { id: w.id, playerId: w.playerId, balance: w.balance.toJSON(), version: w.version };
}

/**
 * Abre a wallet. Saldo inicial > 0 gera a transação interna OPENING e o
 * lançamento CREDIT na mesma transação SQL. Duplicidade (player, moeda) é
 * garantida pela unique do banco; a checagem prévia só dá uma mensagem melhor.
 */
export class CreateWalletUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly instrumentation: Instrumentation,
  ) {}

  async execute(cmd: CreateWalletCommand, correlationId: string): Promise<WalletView> {
    const initialBalance = Money.from(cmd.initialBalance);

    return withConcurrencyRetry(
      () =>
        this.uow.run(async (r) => {
          if (await r.wallets.findByPlayer(cmd.playerId, initialBalance.currency)) {
            throw new WalletAlreadyExistsError(cmd.playerId, initialBalance.currency);
          }
          const now = this.clock.now();
          const wallet = Wallet.open({ id: newId(now.getTime()), playerId: cmd.playerId, initialBalance, at: now });
          this.instrumentation.enrich({ walletId: wallet.id });
          await r.wallets.insert(wallet);

          if (initialBalance.isPositive()) {
            const opening = WagerTransaction.opening({
              id: newId(now.getTime()),
              providerId: INTERNAL_PROVIDER,
              externalTransactionId: `opening:${wallet.id}`,
              idempotencyKey: `${INTERNAL_PROVIDER}:opening:${wallet.id}`,
              payloadHash: sha256Hex(canonicalJson({ walletId: wallet.id, playerId: cmd.playerId, initialBalance: initialBalance.toJSON() })),
              walletId: wallet.id,
              playerId: cmd.playerId,
              roundId: 'opening',
              gameId: INTERNAL_PROVIDER,
              money: initialBalance,
              correlationId,
              createdAt: now,
            });
            opening.markProcessed(undefined, now, wallet.balance);
            const entry = wallet.openingEntry(opening.id)!;
            await r.transactions.insert(opening);
            await r.ledger.insert(entry);

            const ctx = { correlationId, occurredAt: now };
            const events: IntegrationEvent<unknown>[] = [
              WagerTransactionProcessed.from(opening, ctx),
              WalletBalanceChanged.from(wallet, entry, ctx),
            ];
            await r.outbox.enqueue(events.map((e) => OutboxMessage.enqueue(e)));
            this.instrumentation.transactionSettled(opening.kind, opening.status, 'internal');
          }
          this.instrumentation.info('wallet criada', { walletId: wallet.id });
          return toWalletView(wallet);
        }),
      this.instrumentation,
      { operation: 'create-wallet', maxAttempts: 2 },
    );
  }
}
