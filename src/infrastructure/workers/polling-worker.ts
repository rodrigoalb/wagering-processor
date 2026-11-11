import { logger } from '../observability/logger';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Laço de polling com parada graciosa: `stop()` impede novas rodadas e
 * aguarda a rodada em andamento terminar.
 */
export abstract class PollingWorker {
  private running = false;
  private loop?: Promise<void>;

  protected abstract readonly name: string;
  protected abstract readonly intervalMs: number;

  /** Uma rodada. Retorna true se houve trabalho (próxima rodada sem espera). */
  protected abstract tick(): Promise<boolean>;

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
    logger.info({ worker: this.name }, 'worker iniciado');
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    await this.loop;
    logger.info({ worker: this.name }, 'worker parado');
  }

  protected get isRunning(): boolean {
    return this.running;
  }

  private async run(): Promise<void> {
    let failures = 0;
    while (this.running) {
      try {
        const busy = await this.tick();
        failures = 0;
        if (!busy) await sleep(this.intervalMs);
      } catch (err) {
        failures++;
        const delay = Math.min(this.intervalMs * 2 ** failures, 30_000);
        logger.error({ worker: this.name, err: (err as Error).message, retryInMs: delay }, 'falha no worker');
        await sleep(delay);
      }
    }
  }
}
