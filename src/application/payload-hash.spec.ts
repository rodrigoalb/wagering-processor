import { describe, expect, test } from 'bun:test';
import { canonicalJson, wagerPayloadHash, WagerPayloadFields } from './payload-hash';

const base: WagerPayloadFields = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

describe('JSON canônico e payloadHash', () => {
  test('ordena chaves em todos os níveis e omite undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 1, e: 2 }] }, z: undefined })).toBe(
      '{"a":{"c":[3,{"e":2,"f":1}],"d":2},"b":1}',
    );
  });

  test('ordem das chaves na entrada não muda o hash', () => {
    const reordered = Object.fromEntries(Object.entries(base).reverse()) as unknown as WagerPayloadFields;
    expect(wagerPayloadHash(reordered)).toBe(wagerPayloadHash(base));
  });

  test('SHA-256 em hex', () => {
    expect(wagerPayloadHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  test.each([
    ['valor', { money: { amount: '25.01', currency: 'BRL' } }],
    ['moeda', { money: { amount: '25.00', currency: 'USD' } }],
    ['kind', { kind: 'WIN' }],
    ['rodada', { roundId: 'round-988' }],
    ['wallet', { walletId: '0192f291-27dd-7d3f-8071-5f8685deef38' }],
    ['referência', { referenceExternalTransactionId: 'x' }],
  ])('mesma idempotency key com %s diferente gera hash diferente (conflito, não replay)', (_, change) => {
    expect(wagerPayloadHash({ ...base, ...change })).not.toBe(wagerPayloadHash(base));
  });
});
