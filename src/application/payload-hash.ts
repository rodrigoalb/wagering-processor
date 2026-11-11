import { createHash } from 'node:crypto';

/**
 * JSON canônico: chaves ordenadas lexicograficamente em todos os níveis, sem
 * espaços, campos `undefined` omitidos. Mesma entrada lógica produz sempre os
 * mesmos bytes.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Subconjunto de negócio que entra no hash. Header, messageId e metadados de transporte ficam de fora. */
export interface WagerPayloadFields {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  /** amount já normalizado para 2 casas ("25.00", não "25"). */
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

/** payloadHash = hex(SHA-256(UTF-8(JSON canônico do subconjunto de negócio))). */
export function wagerPayloadHash(fields: WagerPayloadFields): string {
  return sha256Hex(
    canonicalJson({
      providerId: fields.providerId,
      externalTransactionId: fields.externalTransactionId,
      playerId: fields.playerId,
      walletId: fields.walletId,
      roundId: fields.roundId,
      gameId: fields.gameId,
      kind: fields.kind,
      money: { amount: fields.money.amount, currency: fields.money.currency },
      referenceExternalTransactionId: fields.referenceExternalTransactionId,
    }),
  );
}
