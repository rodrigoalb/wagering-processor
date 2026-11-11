import { ConcurrencyConflictError } from './errors';
import { Instrumentation } from './instrumentation';

export interface RetryOptions {
  operation: string;
  maxAttempts?: number;
  baseDelayMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Retry limitado para conflitos de concorrência. Cada tentativa refaz a
 * unidade de trabalho inteira (nova transação, nova leitura), então uma
 * corrida de inserção vira replay ou conflito de idempotência na próxima volta.
 * Esgotadas as tentativas, o ConcurrencyConflictError sobe como falha transitória.
 */
export async function withConcurrencyRetry<T>(
  fn: () => Promise<T>,
  instrumentation: Instrumentation,
  { operation, maxAttempts = 5, baseDelayMs = 15 }: RetryOptions,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof ConcurrencyConflictError)) throw err;
      instrumentation.concurrencyConflict(err.reason, operation, attempt);
      if (attempt >= maxAttempts) throw err;
      // Backoff com jitter para não sincronizar os concorrentes.
      await sleep(baseDelayMs * attempt + Math.random() * baseDelayMs);
    }
  }
}
