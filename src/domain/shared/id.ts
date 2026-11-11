import { getRandomValues } from 'node:crypto';

/**
 * UUIDv7 (RFC 9562): ordenável por tempo, o que mantém os índices B-tree
 * do PostgreSQL compactos. Implementado aqui para o domínio não depender
 * de API específica do runtime.
 */
export function newId(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  getRandomValues(bytes);
  const ts = BigInt(now);
  for (let i = 0; i < 6; i++) {
    bytes[i] = Number((ts >> BigInt(8 * (5 - i))) & 0xffn);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // versão 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variante RFC 4122
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
