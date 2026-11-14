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
/**
 * Status que a API devolve. PENDING existe só em memória (a transação é decidida
 * na mesma transação SQL em que nasce), então nunca aparece numa resposta.
 */
const status = z
  .enum(Object.values(WagerTransactionStatus).filter((s) => s !== WagerTransactionStatus.Pending) as [string, ...string[]])
  .meta({ example: 'PROCESSED' });
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

// ------------------------------------------------------------------ exemplos de resposta
// Tipados pelos schemas acima (z.infer): um exemplo fora do formato documentado não compila.
// test/openapi.int.test.ts também os valida em tempo de execução.

const EXAMPLE_WALLET_ID = '01a1dad9-f2c7-7796-8351-099a679b4aa7';
const EXAMPLE_TX_ID = '01a1dadc-1e87-7031-985a-67e5b405f630';
const EXAMPLE_CORRELATION = '01a1dadf-ad21-76b9-9a82-49f73176b543';
const brl = (amount: string) => ({ amount, currency: 'BRL' });

type Submit = z.infer<typeof submitResponse>;
const submitProcessed: Submit = { transactionId: EXAMPLE_TX_ID, status: 'PROCESSED', balance: brl('75.00'), idempotentReplay: false };
const submitReplay: Submit = { ...submitProcessed, idempotentReplay: true };
const submitPending: Submit = { transactionId: EXAMPLE_TX_ID, status: 'PENDING_REFERENCE', balance: brl('100.00'), idempotentReplay: false };
const submitRejected: Submit = {
  transactionId: EXAMPLE_TX_ID,
  status: 'REJECTED',
  balance: brl('75.00'),
  failureCode: 'INSUFFICIENT_FUNDS',
  idempotentReplay: false,
};

const walletExample: z.infer<typeof walletResponse> = { id: EXAMPLE_WALLET_ID, playerId: EXAMPLE_PLAYER, balance: brl('100.00'), version: 1 };

const transactionExample: z.infer<typeof transactionResponse> = {
  id: EXAMPLE_TX_ID,
  providerId: 'provider-a',
  externalTransactionId: 'bet-1',
  idempotencyKey: 'provider-a:bet-1',
  walletId: EXAMPLE_WALLET_ID,
  playerId: EXAMPLE_PLAYER,
  roundId: 'round-1',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: brl('25.00'),
  status: 'PROCESSED',
  failureCode: null,
  referenceExternalTransactionId: null,
  referenceTransactionId: null,
  balance: brl('75.00'),
  referenceAttempts: 0,
  nextReferenceAttemptAt: null,
  createdAt: '2026-11-14T16:24:14.000Z',
  processedAt: '2026-11-14T16:24:14.000Z',
};

const ledgerExample: z.infer<typeof ledgerResponse> = {
  items: [
    {
      id: '01a1dad9-f2c9-7a10-9c2e-6a1b2c3d4e5f',
      transactionId: '01a1dad9-f2c8-7b20-8d3f-7b2c3d4e5f60',
      direction: 'CREDIT',
      money: brl('100.00'),
      balanceBefore: brl('0.00'),
      balanceAfter: brl('100.00'),
      walletVersion: 1,
      createdAt: '2026-11-14T16:20:00.000Z',
    },
    {
      id: '01a1dadc-1e88-7c30-9e4a-8c3d4e5f6071',
      transactionId: EXAMPLE_TX_ID,
      direction: 'DEBIT',
      money: brl('25.00'),
      balanceBefore: brl('100.00'),
      balanceAfter: brl('75.00'),
      walletVersion: 2,
      createdAt: '2026-11-14T16:24:14.000Z',
    },
  ],
  nextCursor: null,
};

const reconciliationExample: z.infer<typeof reconciliationResponse> = {
  walletId: EXAMPLE_WALLET_ID,
  storedBalance: brl('75.00'),
  calculatedBalance: brl('75.00'),
  difference: brl('0.00'),
  consistent: true,
  checkedEntries: 2,
};

const readyExample: z.infer<typeof readinessResponse> = {
  status: 'ok',
  checks: { postgres: { status: 'ok', latencyMs: 2 }, sqs: { status: 'ok', latencyMs: 5 } },
};
const notReadyExample: z.infer<typeof readinessResponse> = {
  status: 'down',
  checks: { postgres: { status: 'down', latencyMs: 2000, error: 'timeout 2000ms' }, sqs: { status: 'ok', latencyMs: 5 } },
};

/** Exemplos de resposta por endpoint e status, expostos para o teste conferir contra os schemas. */
export const RESPONSE_EXAMPLES = {
  submit: { processed: submitProcessed, replay: submitReplay, pending: submitPending, rejected: submitRejected },
  wallet: walletExample,
  transaction: transactionExample,
  ledger: ledgerExample,
  reconciliation: reconciliationExample,
  ready: readyExample,
  notReady: notReadyExample,
};

// ------------------------------------------------------------------ respostas reutilizáveis

type ErrorBody = z.infer<typeof errorResponse>;

const err = (statusCode: number, description: string, example: ErrorBody) =>
  ApiResponse({ status: statusCode, description, schema: toSchema(errorResponse), example });

const errorExample = (code: string, message: string, details?: ErrorBody['error']['details']): ErrorBody => ({
  error: { code, message, ...(details ? { details } : {}) },
  correlationId: EXAMPLE_CORRELATION,
});

const BAD_REQUEST = err(
  400,
  'Payload inválido (formato, Money, UUID, header ausente). Corrigir antes de reenviar.',
  errorExample('VALIDATION_ERROR', 'Payload inválido', [{ path: 'money.amount', message: 'amount inválido "1e2": use decimal não negativo com até 2 casas, ex.: "25.00"' }]),
);
const UNAVAILABLE = err(
  503,
  'Falha transitória (banco fora do ar, timeout de lock). Pode reenviar com a mesma chave; ver Retry-After.',
  errorExample('TRANSIENT_FAILURE', 'Banco de dados indisponível'),
);
const WALLET_NOT_FOUND = err(404, 'Wallet inexistente', errorExample('WALLET_NOT_FOUND', `Wallet ${EXAMPLE_WALLET_ID} não encontrada`));
const TRANSACTION_NOT_FOUND = err(404, 'Transação inexistente', errorExample('TRANSACTION_NOT_FOUND', `Transação ${EXAMPLE_TX_ID} não encontrada`));

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
    ApiResponse({ status: 201, description: 'Criada', schema: toSchema(walletResponse), example: walletExample }),
    BAD_REQUEST,
    err(
      409,
      'Já existe wallet para este player e moeda (WALLET_ALREADY_EXISTS)',
      errorExample('WALLET_ALREADY_EXISTS', `Já existe wallet BRL para o player ${EXAMPLE_PLAYER}`),
    ),
    UNAVAILABLE,
  );

export const ApiGetWallet = () =>
  applyDecorators(
    ApiOperation({ summary: 'Saldo e versão da wallet' }),
    WALLET_ID,
    ApiResponse({ status: 200, description: 'Wallet', schema: toSchema(walletResponse), example: { ...walletExample, balance: brl('75.00'), version: 2 } }),
    BAD_REQUEST,
    WALLET_NOT_FOUND,
  );

export const ApiLedger = () =>
  applyDecorators(
    ApiOperation({ summary: 'Ledger (livro-razão) paginado', description: 'Ordenado por versão da wallet. Cursor opaco e estável.' }),
    WALLET_ID,
    ApiQuery({ name: 'cursor', required: false, description: 'nextCursor da página anterior' }),
    ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } }),
    ApiResponse({ status: 200, description: 'Página do ledger', schema: toSchema(ledgerResponse), example: ledgerExample }),
    BAD_REQUEST,
    WALLET_NOT_FOUND,
  );

export const ApiReconcile = () =>
  applyDecorators(
    ApiOperation({
      summary: 'Reconciliação: saldo gravado x saldo reconstruído pelo ledger',
      description: 'Não corrige nada: divergência é logada, contada em métrica e sinalizada com consistent = false.',
    }),
    WALLET_ID,
    ApiResponse({ status: 200, description: 'Resultado da conferência', schema: toSchema(reconciliationResponse), example: reconciliationExample }),
    BAD_REQUEST,
    WALLET_NOT_FOUND,
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
    ApiResponse({ status: 201, description: 'Processada (PROCESSED)', schema: toSchema(submitResponse), example: submitProcessed }),
    ApiResponse({
      status: 200,
      description: 'Replay: a mesma requisição já tinha sido processada. Devolve o resultado original, com idempotentReplay = true.',
      schema: toSchema(submitResponse),
      example: submitReplay,
    }),
    ApiResponse({
      status: 202,
      description: 'Aceita aguardando a referência (PENDING_REFERENCE): REFUND/ROLLBACK chegou antes da transação que reverte.',
      schema: toSchema(submitResponse),
      example: submitPending,
    }),
    BAD_REQUEST,
    err(
      409,
      'Idempotency-Key já usada com outro conteúdo (IDEMPOTENCY_KEY_CONFLICT)',
      errorExample('IDEMPOTENCY_KEY_CONFLICT', 'Idempotency-Key "provider-a:bet-1" já foi usada com outro payload'),
    ),
    ApiResponse({
      status: 422,
      description: 'Rejeitada por regra de negócio: status REJECTED com failureCode (ou WALLET_NOT_FOUND no formato de erro)',
      schema: { oneOf: [toSchema(submitResponse), toSchema(errorResponse)] },
      examples: {
        rejeitada: { summary: 'Transação rejeitada (ex.: aposta sem saldo)', value: submitRejected },
        walletInexistente: {
          summary: 'Wallet do corpo não existe (nada é gravado)',
          value: errorExample('WALLET_NOT_FOUND', `Wallet ${EXAMPLE_WALLET_ID} não encontrada`),
        },
      },
    }),
    UNAVAILABLE,
  );

export const ApiGetTransaction = () =>
  applyDecorators(
    ApiOperation({ summary: 'Consulta transação pelo id interno' }),
    ApiParam({ name: 'transactionId', format: 'uuid', description: 'transactionId devolvido pela submissão' }),
    ApiResponse({ status: 200, description: 'Transação', schema: toSchema(transactionResponse), example: transactionExample }),
    BAD_REQUEST,
    TRANSACTION_NOT_FOUND,
  );

export const ApiGetTransactionByExternal = () =>
  applyDecorators(
    ApiOperation({ summary: 'Consulta transação pelo id do provedor' }),
    ApiParam({ name: 'providerId', example: 'provider-a' }),
    ApiParam({ name: 'externalTransactionId', example: 'bet-1' }),
    ApiResponse({ status: 200, description: 'Transação', schema: toSchema(transactionResponse), example: transactionExample }),
    TRANSACTION_NOT_FOUND,
  );

export const ApiLive = () =>
  applyDecorators(
    ApiOperation({ summary: 'Liveness: o processo está vivo (não depende de banco nem fila)' }),
    ApiResponse({ status: 200, description: 'Vivo', schema: { type: 'object', properties: { status: { type: 'string', example: 'ok' } } } }),
  );

export const ApiReady = () =>
  applyDecorators(
    ApiOperation({ summary: 'Readiness: PostgreSQL e SQS alcançáveis' }),
    ApiResponse({ status: 200, description: 'Pronto', schema: toSchema(readinessResponse), example: readyExample }),
    ApiResponse({ status: 503, description: 'Alguma dependência fora', schema: toSchema(readinessResponse), example: notReadyExample }),
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
