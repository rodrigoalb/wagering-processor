import { ProcessPendingReferencesUseCase } from '../../application/process-pending-references.use-case';
import { AppConfig } from '../config';
import { logger, withLogContext } from '../observability/logger';
import { PollingWorker } from './polling-worker';

/** Worker agendado que reprocessa PENDING_REFERENCE com backoff exponencial. */
export class PendingReferenceWorker extends PollingWorker {
  protected readonly name = 'pending-reference-worker';
  protected readonly intervalMs: number;

  constructor(
    private readonly useCase: ProcessPendingReferencesUseCase,
    private readonly config: AppConfig,
  ) {
    super();
    this.intervalMs = config.pendingReferences.pollMs;
  }

  protected async tick(): Promise<boolean> {
    return withLogContext({}, async () => {
      const summary = await this.useCase.runOnce(this.config.pendingReferences.batchSize);
      if (summary.examined > 0) logger.info(summary, 'rodada de referências pendentes');
      return summary.examined >= this.config.pendingReferences.batchSize;
    });
  }
}
