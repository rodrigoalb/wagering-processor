import { z } from 'zod';
import { ValidationError } from '../domain/shared/domain-error';

/**
 * Contratos de entrada (HTTP e SQS). A validação de formato do dinheiro fica
 * no próprio `Money.from`, para existir uma única regra.
 */

const text = (max: number) => z.string().min(1).max(max);
const moneySchema = z.object({ amount: z.string(), currency: z.string() });

export const wagerFieldsSchema = z.object({
  providerId: text(100).regex(/^[A-Za-z0-9._-]+$/, 'providerId aceita letras, números, ponto, hífen e sublinhado'),
  externalTransactionId: text(200),
  playerId: z.uuid(),
  walletId: z.uuid(),
  roundId: text(200),
  gameId: text(200),
  // OPENING fica de fora: é interno e não pode ser submetido.
  kind: z.enum(['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK']),
  money: moneySchema,
  referenceExternalTransactionId: text(200).optional(),
});

export const idempotencyKeySchema = z
  .string({ error: 'Idempotency-Key é obrigatório' })
  .min(1, 'Idempotency-Key é obrigatório')
  .max(300)
  .regex(/^[\x21-\x7E]+$/, 'Idempotency-Key aceita apenas ASCII visível');

export const wagerMessageSchema = z.object({
  messageId: text(200),
  type: z.literal('WagerTransactionRequested'),
  occurredAt: z.iso.datetime(),
  data: wagerFieldsSchema.extend({ idempotencyKey: idempotencyKeySchema }),
});

export const createWalletSchema = z.object({
  playerId: z.uuid(),
  initialBalance: moneySchema,
});

export const ledgerQuerySchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export class PayloadValidationError extends ValidationError {
  constructor(readonly issues: { path: string; message: string }[]) {
    super(`Payload inválido: ${issues.map((i) => `${i.path || '(raiz)'}: ${i.message}`).join('; ')}`);
  }
}

export function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new PayloadValidationError(
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}
