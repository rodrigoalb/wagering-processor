import { InboxMessage } from '../domain/messaging/inbox-message';
import { Money, MoneyProps } from '../domain/money/money';
import { newId } from '../domain/shared/id';
import { FailureCode } from '../domain/wager/failure-code';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../domain/wager/wager-transaction';
import { IdempotencyConflictError, MessageIdReuseError, WalletNotFoundError } from './errors';
import { Instrumentation, Source } from './instrumentation';
import { wagerPayloadHash } from './payload-hash';
import { Clock, TransactionalRepositories, UnitOfWork } from './ports';
import { withConcurrencyRetry } from './retry';
import { WagerProcessor } from './wager-processor';

export interface SubmitWagerCommand {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export interface SubmitContext {
  source: Source;
  correlationId: string;
  causationId?: string;
  /** Presente quando a entrada é a fila: registra a mensagem no inbox na mesma transação. */
  inbox?: { consumerName: string; messageId: string; payloadHash: string };
}

export interface SubmitResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
  /** A mensagem (consumerName, messageId) já tinha sido processada. */
  duplicateMessage?: boolean;
}

/**
 * Caso de uso único para HTTP e SQS.
 *
 * Fluxo dentro de UMA transação SQL:
 *  1. (SQS) registra a mensagem no inbox: INSERT ... ON CONFLICT DO NOTHING;
 *  2. procura a Idempotency-Key: se existe, replay (mesmo payload) ou conflito;
 *  3. trava a linha da wallet (SELECT ... FOR UPDATE);
 *  4. procura a chave de novo: quem esperava o lock vê o commit de quem passou antes;
 *  5. aplica as regras, grava transação, saldo, ledger e outbox; marca o inbox.
 */
export class SubmitWagerTransactionUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly processor: WagerProcessor,
    private readonly clock: Clock,
    private readonly instrumentation: Instrumentation,
  ) {}

  async execute(cmd: SubmitWagerCommand, ctx: SubmitContext): Promise<SubmitResult> {
    // Validação de entrada fora da transação: payload inválido nunca abre transação.
    const money = Money.from(cmd.money);
    const payloadHash = wagerPayloadHash({ ...cmd, money: money.toJSON() });
    this.instrumentation.enrich({ walletId: cmd.walletId, providerId: cmd.providerId });

    return withConcurrencyRetry(
      () =>
        this.uow.run(async (r) => {
          const now = this.clock.now();
          let inbox: InboxMessage | undefined;
          if (ctx.inbox) {
            inbox = InboxMessage.receive({ ...ctx.inbox, receivedAt: now });
            if (!(await r.inbox.tryRegister(inbox))) {
              // Só é redelivery se o conteúdo for o mesmo. messageId repetido com
              // outro conteúdo é erro do produtor e não pode ser engolido como duplicata.
              const previous = await r.inbox.find(ctx.inbox.consumerName, ctx.inbox.messageId);
              if (previous && previous.payloadHash !== ctx.inbox.payloadHash) {
                this.instrumentation.duplicateDetected('inbox-payload-mismatch', ctx.source);
                throw new MessageIdReuseError(ctx.inbox.messageId);
              }
              this.instrumentation.duplicateDetected('inbox', ctx.source);
              const existing = await r.transactions.findByIdempotencyKey(cmd.idempotencyKey);
              if (existing) return { ...this.toResult(existing, true), duplicateMessage: true };
              // Mesmo conteúdo implica mesma chave, e inbox e transação são gravados no mesmo commit.
              throw new Error(`Inbox ${ctx.inbox.messageId} existe sem transação correspondente`);
            }
          }

          const finish = async (result: SubmitResult): Promise<SubmitResult> => {
            if (inbox) {
              inbox.markProcessed(now);
              await r.inbox.markProcessed(inbox);
            }
            return result;
          };

          const replay = await this.findExisting(r, cmd, payloadHash, ctx.source);
          if (replay) return finish(replay);

          const wallet = await r.wallets.lockById(cmd.walletId);
          if (!wallet) throw new WalletNotFoundError(cmd.walletId, 'business');

          const replayAfterLock = await this.findExisting(r, cmd, payloadHash, ctx.source);
          if (replayAfterLock) return finish(replayAfterLock);

          const tx = WagerTransaction.create({
            id: newId(now.getTime()),
            providerId: cmd.providerId,
            externalTransactionId: cmd.externalTransactionId,
            idempotencyKey: cmd.idempotencyKey,
            payloadHash,
            walletId: cmd.walletId,
            playerId: cmd.playerId,
            roundId: cmd.roundId,
            gameId: cmd.gameId,
            kind: cmd.kind,
            money,
            referenceExternalTransactionId: cmd.referenceExternalTransactionId,
            correlationId: ctx.correlationId,
            createdAt: now,
          });
          this.instrumentation.enrich({ transactionId: tx.id });

          await this.processor.settle(r, tx, wallet, {
            isNew: true,
            now,
            source: ctx.source,
            events: { correlationId: ctx.correlationId, causationId: ctx.causationId ?? ctx.inbox?.messageId },
          });
          return finish(this.toResult(tx, false));
        }),
      this.instrumentation,
      { operation: 'submit-wager-transaction' },
    );
  }

  private async findExisting(
    r: TransactionalRepositories,
    cmd: SubmitWagerCommand,
    payloadHash: string,
    source: Source,
  ): Promise<SubmitResult | undefined> {
    // Em READ COMMITTED cada SELECT vê um snapshot novo: entre a busca por chave
    // e a busca por id externo outra requisição pode ter commitado. Por isso a
    // decisão é tomada sobre o registro encontrado, não sobre qual busca o achou.
    const existing =
      (await r.transactions.findByIdempotencyKey(cmd.idempotencyKey)) ??
      (await r.transactions.findByExternalId(cmd.providerId, cmd.externalTransactionId));
    if (!existing) return undefined;

    if (existing.idempotencyKey === cmd.idempotencyKey) {
      if (!existing.matchesPayload(payloadHash)) {
        this.instrumentation.duplicateDetected('payload-conflict', source);
        throw new IdempotencyConflictError(cmd.idempotencyKey);
      }
      this.instrumentation.duplicateDetected('idempotent-replay', source);
      this.instrumentation.enrich({ transactionId: existing.id });
      return this.toResult(existing, true);
    }
    // Mesmo (providerId, externalTransactionId) já registrado com outra chave: também é conflito.
    this.instrumentation.duplicateDetected('payload-conflict', source);
    throw new IdempotencyConflictError(
      cmd.idempotencyKey,
      `conflita com a transação (${cmd.providerId}, ${cmd.externalTransactionId}), registrada com outra chave`,
    );
  }

  private toResult(tx: WagerTransaction, idempotentReplay: boolean): SubmitResult {
    return {
      transactionId: tx.id,
      status: tx.status,
      balance: (tx.resultBalance ?? Money.zero(tx.money.currency)).toJSON(),
      ...(tx.failureCode ? { failureCode: tx.failureCode } : {}),
      idempotentReplay,
    };
  }
}
