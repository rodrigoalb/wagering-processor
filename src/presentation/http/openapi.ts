import { applyDecorators, INestApplication } from '@nestjs/common';
import { ApiBody, ApiHeader, ApiOperation, ApiParam, ApiProduces, ApiQuery, ApiResponse, ApiTags, DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { z } from 'zod';
import { FailureCode } from '../../domain/wager/failure-code';
import { WagerTransactionStatus } from '../../domain/wager/wager-transaction';
import { createWalletSchema, wagerFieldsSchema } from '../contracts';

/**
 * Documentação OpenAPI (Swagger UI em /docs, JSON em /docs-json).
 *
 * Não faz parte do enunciado: é uma conveniência para testar a API pelo
 * navegador. Os corpos de ENTRADA são gerados dos mesmos schemas zod que
 * validam as requisições (contracts.ts), então documentação e validação não
 * têm como divergir. Os schemas de SAÍDA abaixo são conferidos contra respostas
 * reais em test/openapi.int.test.ts.
 */

// ------------------------------------------------------------------ helpers

type JsonSchema = Record<string, unknown>;

/** zod -> JSON Schema no dialeto do OpenAPI 3.0. `input`: o que o cliente envia. */
function toSchema(schema: z.ZodType, io: 'input' | 'output' = 'output'): JsonSchema {
  const json = z.toJSONSchema(schema, { target: 'openapi-3.0', io } as Parameters<typeof z.toJSONSchema>[1]) as JsonSchema;
  delete json.$schema;
  return json;
}

const EXAMPLE_PLAYER = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
const EXAMPLE_WALLET = 'COLE-AQUI-O-ID-DA-WALLET';

// ------------------------------------------------------------------ schemas de saída

const money = z.object({
  amount: z.string().meta({ description: 'Decimal com exatamente 2 casas, sempre string (nunca number)', example: '975.00' }),
  currency: z.string().meta({ description: 'ISO-4217', example: 'BRL' }),
});

const uuid = z.uuid();
const status = z.enum(Object.values(WagerTransactionStatus) as [string, ...string[]]);
const failureCode = z.enum(Object.values(FailureCode) as [string, ...string[]]);

export const errorResponse = z.object({
  error: z.object({
    code: z.string().meta({ example: 'VALIDATION_ERROR' }),
    message: z.string(),
    details: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  }),
  correlationId: z.string().optional(),
});

export const walletResponse = z.object({
  id: uuid,
  playerId: uuid,
  balance: money,
  version: z.number().int().meta({ description: 'Começa em 1 e só incrementa quando o saldo muda' }),
});

export const submitResponse = z.object({
  transactionId: uuid,
  status,
  balance: money.meta({ description: 'Saldo observado quando a transação foi decidida (o replay devolve o mesmo valor)' }),
  failureCode: failureCode.optional().meta({ description: 'Presente quando status = REJECTED' }),
  idempotentReplay: z.boolean().meta({ description: 'true quando a resposta é a repetição de uma requisição já processada' }),
});

export const transactionResponse = z.object({
  id: uuid,
  providerId: z.string(),
  externalTransactionId: z.string(),
  idempotencyKey: z.string(),
  walletId: uuid,
  playerId: uuid,
  roundId: z.string(),
  gameId: z.string(),
  kind: z.enum(['OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK']),
  money,
  status,
  failureCode: failureCode.nullable(),
  referenceExternalTransactionId: z.string().nullable(),
  referenceTransactionId: uuid.nullable(),
  balance: money.nullable(),
  referenceAttempts: z.number().int(),
  nextReferenceAttemptAt: z.string().nullable(),
  createdAt: z.string(),
  processedAt: z.string().nullable(),
});

export const ledgerResponse = z.object({
  items: z.array(
    z.object({
      id: uuid,
      transactionId: uuid,
      direction: z.enum(['DEBIT', 'CREDIT']),
      money,
      balanceBefore: money,
      balanceAfter: money,
      walletVersion: z.number().int(),
      createdAt: z.string(),
    }),
  ),
  nextCursor: z.string().nullable().meta({ description: 'Passe em ?cursor= para a próxima página; null na última' }),
});

export const reconciliationResponse = z.object({
  walletId: uuid,
  storedBalance: money,
  calculatedBalance: money,
  difference: money,
  consistent: z.boolean(),
  checkedEntries: z.number().int(),
});

const check = z.object({ status: z.enum(['ok', 'down']), latencyMs: z.number(), error: z.string().optional() });
export const readinessResponse = z.object({ status: z.enum(['ok', 'down']), checks: z.object({ postgres: check, sqs: check }) });

// ------------------------------------------------------------------ respostas reutilizáveis

const err = (statusCode: number, description: string) =>
  ApiResponse({ status: statusCode, description, schema: toSchema(errorResponse) });

const BAD_REQUEST = err(400, 'Payload inválido (formato, Money, UUID, header ausente). Corrigir antes de reenviar.');
const UNAVAILABLE = err(503, 'Falha transitória (banco fora do ar, timeout de lock). Pode reenviar com a mesma chave; ver Retry-After.');

const CORRELATION = ApiHeader({
  name: 'X-Correlation-Id',
  required: false,
  description: 'Opcional. Propagado para logs e eventos; gerado se ausente e devolvido na resposta.',
});

const WALLET_ID = ApiParam({ name: 'walletId', format: 'uuid', description: 'id retornado por POST /wallets' });

// ------------------------------------------------------------------ exemplos de transação

function wager(kind: string, ext: string, amount: string, ref?: string) {
  return {
    providerId: 'provider-a',
    externalTransactionId: ext,
    playerId: EXAMPLE_PLAYER,
    walletId: EXAMPLE_WALLET,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: { amount, currency: 'BRL' },
    ...(ref ? { referenceExternalTransactionId: ref } : {}),
  };
}

const WAGER_EXAMPLES = {
  BET: { summary: 'BET: aposta (debita)', value: wager('BET', 'bet-1', '25.00') },
  WIN: { summary: 'WIN: prêmio (credita), referenciando a BET', value: wager('WIN', 'win-1', '60.00', 'bet-1') },
  LOSS: { summary: 'LOSS: derrota (não move saldo)', value: wager('LOSS', 'loss-1', '25.00', 'bet-1') },
  REFUND: { summary: 'REFUND: devolve a BET', value: wager('REFUND', 'refund-1', '25.00', 'bet-1') },
  // A mesma BET só pode ser revertida uma vez: depois do REFUND acima, este ROLLBACK é rejeitado
  // (REFERENCE_ALREADY_REVERSED). Para vê-lo processado, use-o numa BET que não teve REFUND.
  ROLLBACK: {
    summary: 'ROLLBACK: desfaz a BET (use em vez do REFUND; a BET só é revertida uma vez)',
    value: wager('ROLLBACK', 'rollback-1', '25.00', 'bet-1'),
  },
};

// ------------------------------------------------------------------ decorators por endpoint

export const ApiWallets = () => applyDecorators(ApiTags('Wallets'), CORRELATION);
export const ApiWagering = () => applyDecorators(ApiTags('Wagering'), CORRELATION);
export const ApiOps = () => applyDecorators(ApiTags('Operação'));

export const ApiCreateWallet = () =>
  applyDecorators(
    ApiOperation({
      summary: 'Cria wallet',
      description:
        'Saldo inicial > 0 gera a transação interna OPENING e o lançamento CREDIT na mesma transação SQL. ' +
        'Uma wallet por (playerId, moeda): para criar outra, troque o playerId.',
    }),
    ApiBody({
      schema: toSchema(createWalletSchema, 'input'),
      examples: {
        BRL: { summary: 'Wallet BRL com 100,00', value: { playerId: EXAMPLE_PLAYER, initialBalance: { amount: '100.00', currency: 'BRL' } } },
      },
    }),
    ApiResponse({ status: 201, description: 'Criada', schema: toSchema(walletResponse) }),
    BAD_REQUEST,
    err(409, 'Já existe wallet para este player e moeda (WALLET_ALREADY_EXISTS)'),
    UNAVAILABLE,
  );

export const ApiGetWallet = () =>
  applyDecorators(
    ApiOperation({ summary: 'Saldo e versão da wallet' }),
    WALLET_ID,
    ApiResponse({ status: 200, description: 'Wallet', schema: toSchema(walletResponse) }),
    BAD_REQUEST,
    err(404, 'Wallet inexistente'),
  );

export const ApiLedger = () =>
  applyDecorators(
    ApiOperation({ summary: 'Ledger (livro-razão) paginado', description: 'Ordenado por versão da wallet. Cursor opaco e estável.' }),
    WALLET_ID,
    ApiQuery({ name: 'cursor', required: false, description: 'nextCursor da página anterior' }),
    ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } }),
    ApiResponse({ status: 200, description: 'Página do ledger', schema: toSchema(ledgerResponse) }),
    BAD_REQUEST,
    err(404, 'Wallet inexistente'),
  );

export const ApiReconcile = () =>
  applyDecorators(
    ApiOperation({
      summary: 'Reconciliação: saldo gravado x saldo reconstruído pelo ledger',
      description: 'Não corrige nada: divergência é logada, contada em métrica e sinalizada com consistent = false.',
    }),
    WALLET_ID,
    ApiResponse({ status: 200, description: 'Resultado da conferência', schema: toSchema(reconciliationResponse) }),
    BAD_REQUEST,
    err(404, 'Wallet inexistente'),
  );

export const ApiSubmitTransaction = () =>
  applyDecorators(
    ApiOperation({
      summary: 'Submete transação (BET, WIN, LOSS, REFUND, ROLLBACK)',
      description:
        'Antes de testar: crie uma wallet e troque walletId (e playerId, se mudou) no exemplo. ' +
        'Para cada transação nova, use um externalTransactionId e uma Idempotency-Key novos. ' +
        'Repetir a mesma requisição devolve o resultado original (idempotentReplay = true); ' +
        'mesma chave com outro conteúdo é 409.',
    }),
    ApiHeader({
      name: 'Idempotency-Key',
      required: true,
      description: 'Fonte da verdade da idempotência. Recomendado: "{providerId}:{externalTransactionId}".',
      example: 'provider-a:bet-1',
    }),
    ApiBody({ schema: toSchema(wagerFieldsSchema, 'input'), examples: WAGER_EXAMPLES }),
    ApiResponse({ status: 201, description: 'Processada (PROCESSED)', schema: toSchema(submitResponse) }),
    ApiResponse({ status: 200, description: 'Replay de uma transação já processada (idempotentReplay = true)', schema: toSchema(submitResponse) }),
    ApiResponse({ status: 202, description: 'Aceita aguardando a referência (PENDING_REFERENCE)', schema: toSchema(submitResponse) }),
    BAD_REQUEST,
    err(409, 'Idempotency-Key já usada com outro conteúdo (IDEMPOTENCY_KEY_CONFLICT)'),
    ApiResponse({
      status: 422,
      description: 'Rejeitada por regra de negócio: status REJECTED com failureCode (ou WALLET_NOT_FOUND no formato de erro)',
      schema: { oneOf: [toSchema(submitResponse), toSchema(errorResponse)] },
    }),
    UNAVAILABLE,
  );

export const ApiGetTransaction = () =>
  applyDecorators(
    ApiOperation({ summary: 'Consulta transação pelo id interno' }),
    ApiParam({ name: 'transactionId', format: 'uuid', description: 'transactionId devolvido pela submissão' }),
    ApiResponse({ status: 200, description: 'Transação', schema: toSchema(transactionResponse) }),
    BAD_REQUEST,
    err(404, 'Transação inexistente'),
  );

export const ApiGetTransactionByExternal = () =>
  applyDecorators(
    ApiOperation({ summary: 'Consulta transação pelo id do provedor' }),
    ApiParam({ name: 'providerId', example: 'provider-a' }),
    ApiParam({ name: 'externalTransactionId', example: 'bet-1' }),
    ApiResponse({ status: 200, description: 'Transação', schema: toSchema(transactionResponse) }),
    err(404, 'Transação inexistente'),
  );

export const ApiLive = () =>
  applyDecorators(
    ApiOperation({ summary: 'Liveness: o processo está vivo (não depende de banco nem fila)' }),
    ApiResponse({ status: 200, description: 'Vivo', schema: { type: 'object', properties: { status: { type: 'string', example: 'ok' } } } }),
  );

export const ApiReady = () =>
  applyDecorators(
    ApiOperation({ summary: 'Readiness: PostgreSQL e SQS alcançáveis' }),
    ApiResponse({ status: 200, description: 'Pronto', schema: toSchema(readinessResponse) }),
    ApiResponse({ status: 503, description: 'Alguma dependência fora', schema: toSchema(readinessResponse) }),
  );

export const ApiMetrics = () =>
  applyDecorators(
    ApiOperation({ summary: 'Métricas no formato Prometheus' }),
    ApiProduces('text/plain'),
    ApiResponse({ status: 200, description: 'Texto no formato de exposição do Prometheus' }),
  );

// ------------------------------------------------------------------ montagem

export const DOCS_PATH = 'docs';

export function setupOpenApi(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('Distributed Wagering Processor')
    .setDescription(
      'API do processador de apostas. Dinheiro é sempre string decimal com 2 casas. ' +
        'Status HTTP: 201 processada, 200 replay/consulta, 202 aguardando referência, 400 payload inválido, ' +
        '404 inexistente, 409 conflito, 422 rejeição de negócio, 503 falha transitória (pode reenviar). ' +
        'Envio pela fila SQS não é HTTP e não aparece aqui (ver README).',
    )
    .setVersion('1.0')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup(DOCS_PATH, app, document, {
    jsonDocumentUrl: `${DOCS_PATH}-json`,
    swaggerOptions: { tryItOutEnabled: true, displayRequestDuration: true, docExpansion: 'list' },
  });
}
