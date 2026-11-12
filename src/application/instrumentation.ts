import { ConflictReason } from './errors';

export type Source = 'http' | 'sqs' | 'worker' | 'internal';

/**
 * Porta de observabilidade da aplicação. Os casos de uso relatam fatos;
 * a infraestrutura decide como virar log e métrica (pino + Prometheus).
 */
export interface Instrumentation {
  transactionSettled(kind: string, status: string, source: Source): void;
  duplicateDetected(type: 'idempotent-replay' | 'inbox' | 'payload-conflict' | 'inbox-payload-mismatch', source: Source): void;
  concurrencyConflict(reason: ConflictReason, operation: string, attempt: number): void;
  referenceExpired(transactionId: string): void;
  reconciliationMismatch(walletId: string, stored: string, calculated: string): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  /** Acrescenta identificadores ao contexto de log corrente. */
  enrich(fields: { transactionId?: string; walletId?: string; providerId?: string }): void;
}

export const INSTRUMENTATION = Symbol('INSTRUMENTATION');

export const noopInstrumentation: Instrumentation = {
  transactionSettled: () => {},
  duplicateDetected: () => {},
  concurrencyConflict: () => {},
  referenceExpired: () => {},
  reconciliationMismatch: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  enrich: () => {},
};
