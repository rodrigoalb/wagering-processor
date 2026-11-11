import { ApplicationError } from './errors';
import { FailureCode } from '../domain/wager/failure-code';
import { WagerTransactionStatus } from '../domain/wager/wager-transaction';
import { Instrumentation } from './instrumentation';
import { Clock, UnitOfWork } from './ports';
import { withConcurrencyRetry } from './retry';
import { WagerProcessor } from './wager-processor';

export interface PendingRunSummary {
  examined: number;
  settled: number;
  stillPending: number;
  skipped: number;
  failed: number;
}

/**
 * Reprocessa transações em PENDING_REFERENCE vencidas. Seguro com várias
 * instâncias: cada item trava a wallet e relê o status depois do lock; se
 * outra instância já tratou, pula.
 */
export class ProcessPendingReferencesUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly processor: WagerProcessor,
    private readonly clock: Clock,
    private readonly instrumentation: Instrumentation,
  ) {}

  async runOnce(batchSize: number): Promise<PendingRunSummary> {
    const summary: PendingRunSummary = { examined: 0, settled: 0, stillPending: 0, skipped: 0, failed: 0 };
    const due = await this.uow.read.transactions.findDuePendingReferences(this.clock.now(), batchSize);

    for (const candidate of due) {
      summary.examined++;
      try {
        const status = await withConcurrencyRetry(
          () =>
            this.uow.run(async (r) => {
              const wallet = await r.wallets.lockById(candidate.walletId);
              const tx = await r.transactions.findById(candidate.id);
              const now = this.clock.now();
              if (
                !wallet ||
                !tx ||
                tx.status !== WagerTransactionStatus.PendingReference ||
                (tx.nextReferenceAttemptAt && tx.nextReferenceAttemptAt > now)
              ) {
                return undefined; // outra instância já tratou
              }
              this.instrumentation.enrich({ transactionId: tx.id, walletId: tx.walletId, providerId: tx.providerId });
              await this.processor.settle(r, tx, wallet, {
                isNew: false,
                now,
                source: 'worker',
                events: { correlationId: tx.correlationId, causationId: tx.id },
              });
              return tx.status;
            }),
          this.instrumentation,
          { operation: 'pending-reference' },
        );
        if (status === undefined) summary.skipped++;
        else if (status === WagerTransactionStatus.PendingReference) summary.stillPending++;
        else summary.settled++;
      } catch (err) {
        if (err instanceof ApplicationError && err.kind === 'transient') {
          // Banco instável: fica para a próxima rodada, nada foi gravado.
          this.instrumentation.warn('reprocessamento adiado por falha transitória', { transactionId: candidate.id, error: err.message });
          continue;
        }
        summary.failed++;
        await this.markFailed(candidate.id, err);
      }
    }
    return summary;
  }

  /** Erro permanente inesperado: a transação vira FAILED, terminal e auditável. */
  private async markFailed(transactionId: string, cause: unknown): Promise<void> {
    this.instrumentation.error('falha permanente no reprocessamento', {
      transactionId,
      error: cause instanceof Error ? cause.message : String(cause),
    });
    try {
      await this.uow.run(async (r) => {
        const tx = await r.transactions.findById(transactionId);
        if (!tx || tx.isTerminal()) return;
        const previous = tx.status;
        tx.fail(FailureCode.InternalError, this.clock.now());
        await r.transactions.updateStatus(tx, previous);
      });
      this.instrumentation.transactionSettled('UNKNOWN', WagerTransactionStatus.Failed, 'worker');
    } catch (err) {
      this.instrumentation.error('não foi possível marcar FAILED', { transactionId, error: (err as Error).message });
    }
  }
}
