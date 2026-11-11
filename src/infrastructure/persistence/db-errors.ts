import { ConnectionException, DriverException } from '@mikro-orm/core';

export type DbErrorClass =
  | 'unique-violation' // corrida de inserção: refazer a unidade de trabalho resolve (vira replay ou conflito)
  | 'deadlock'
  | 'serialization'
  | 'lock-timeout'
  | 'connection' // banco fora do ar, pool esgotado
  | 'integrity' // constraint/trigger violada: bug ou dado corrompido, não adianta repetir
  | 'unknown';

function sqlState(err: unknown): string | undefined {
  const e = err as { code?: unknown; sqlState?: unknown; cause?: { code?: unknown } } | undefined;
  for (const c of [e?.sqlState, e?.code, e?.cause?.code]) {
    if (typeof c === 'string') return c;
  }
  return undefined;
}

export function classifyDbError(err: unknown): DbErrorClass {
  if (err instanceof ConnectionException) return 'connection';
  const state = sqlState(err);
  const message = err instanceof Error ? err.message : '';
  if (state === '23505') return 'unique-violation';
  if (state === '40P01') return 'deadlock';
  if (state === '40001') return 'serialization';
  if (state === '55P03' || state === '57014') return 'lock-timeout'; // lock_not_available / query_canceled (lock_timeout)
  if (state?.startsWith('08') || state === '57P01' || state === '57P03' || state === '53300') return 'connection';
  if (state && ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE'].includes(state)) return 'connection';
  if (/Timeout acquiring a connection|Connection terminated|connect ECONNREFUSED/i.test(message)) return 'connection';
  if (state?.startsWith('23') || state === 'P0001') return 'integrity';
  if (err instanceof DriverException) return 'unknown';
  return 'unknown';
}

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  if (classifyDbError(err) !== 'unique-violation') return false;
  if (!constraint) return true;
  return err instanceof Error && err.message.includes(constraint);
}
