import { AsyncLocalStorage } from 'node:async_hooks';
import pino from 'pino';

/** Campos de rastreio permitidos nos logs. Nunca valores monetários ou payloads. */
export interface LogContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
  instanceId?: string;
}

const storage = new AsyncLocalStorage<LogContext>();
let instanceId: string | undefined = process.env.INSTANCE_ID;

/** Chamado no bootstrap com o instanceId resolvido pela config (inclusive o default). */
export function setLogInstanceId(id: string): void {
  instanceId = id;
}

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'wagering-processor' },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (label) => ({ level: label }) },
  // Defesa extra: se algum campo sensível escapar para um log, é mascarado.
  redact: {
    paths: ['money', 'amount', 'balance', 'payload', 'body', 'data', '*.money', '*.amount', '*.balance', 'authorization'],
    censor: '[redacted]',
  },
  mixin: () => ({ instanceId, ...storage.getStore() }),
});

export function withLogContext<T>(ctx: LogContext, fn: () => T): T {
  return storage.run({ ...storage.getStore(), ...ctx }, fn);
}

/** Acrescenta campos ao contexto atual (ex.: transactionId descoberto no meio do fluxo). */
export function enrichLogContext(ctx: LogContext): void {
  const store = storage.getStore();
  if (store) Object.assign(store, ctx);
}

export function currentLogContext(): LogContext {
  return { ...storage.getStore() };
}
