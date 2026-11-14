import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  errorResponse,
  ledgerResponse,
  readinessResponse,
  reconciliationResponse,
  RESPONSE_EXAMPLES,
  submitResponse,
  transactionResponse,
  walletResponse,
} from '../src/presentation/http/openapi';
import {
  createQueues,
  deleteQueues,
  http,
  ledgerInvariantViolations,
  resetDatabase,
  startApp,
  submit,
  testConfig,
  TestQueues,
  wagerBody,
} from './support/harness';

/**
 * A documentação (Swagger) precisa descrever a API de verdade. Os corpos de
 * entrada já saem dos schemas que validam as requisições; aqui garantimos que
 * as respostas REAIS obedecem aos schemas de saída documentados e que nenhuma
 * rota ficou sem documentação.
 */

let app: INestApplication;
let url: string;
let queues: TestQueues;
let doc: { paths: Record<string, Record<string, { requestBody?: any; responses: Record<string, unknown> }>> };

beforeAll(async () => {
  await resetDatabase();
  queues = await createQueues();
  ({ app, url } = await startApp(testConfig(queues, { SQS_CONSUMER_ENABLED: 'false' })));
  doc = (await http('GET', `${url}/docs-json`)).body;
});

afterAll(async () => {
  expect(await ledgerInvariantViolations()).toEqual([]);
  await app?.close();
  await deleteQueues(queues);
});

/** Valida a resposta contra o schema e garante que não há campo fora da documentação. */
function conforms(schema: z.ZodObject, body: unknown) {
  const parsed = schema.safeParse(body);
  expect(parsed.error?.issues ?? []).toEqual([]);
  const extra = Object.keys(body as object).filter((k) => !(k in schema.shape));
  expect(extra).toEqual([]);
}

describe('Swagger', () => {
  test('a página /docs e o documento /docs-json estão disponíveis, sem autenticação', async () => {
    const page = await fetch(`${url}/docs`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('swagger-ui');
    for (const asset of ['swagger-ui.css', 'swagger-ui-bundle.js', 'swagger-ui-init.js']) {
      expect((await fetch(`${url}/docs/${asset}`)).status).toBe(200);
    }
    expect(doc.paths).toBeDefined();
  });

  test('todas as rotas da API estão documentadas com seus status', () => {
    const expected: Record<string, Record<string, string[]>> = {
      '/wallets': { post: ['201', '400', '409', '503'] },
      '/wallets/{walletId}': { get: ['200', '400', '404'] },
      '/wallets/{walletId}/ledger': { get: ['200', '400', '404'] },
      '/wallets/{walletId}/reconciliation': { post: ['200', '400', '404'] },
      '/wagering/transactions': { post: ['200', '201', '202', '400', '409', '422', '503'] },
      '/wagering/transactions/{transactionId}': { get: ['200', '400', '404'] },
      '/providers/{providerId}/wagering/transactions/{externalTransactionId}': { get: ['200', '404'] },
      '/health/live': { get: ['200'] },
      '/health/ready': { get: ['200', '503'] },
      '/metrics': { get: ['200'] },
    };
    expect(Object.keys(doc.paths).sort()).toEqual(Object.keys(expected).sort());
    for (const [path, methods] of Object.entries(expected)) {
      for (const [method, statuses] of Object.entries(methods)) {
        expect(Object.keys(doc.paths[path]![method]!.responses).sort()).toEqual(statuses);
      }
    }
  });

  test('a submissão documenta o header Idempotency-Key uma única vez, como obrigatório', () => {
    const params = (doc.paths['/wagering/transactions']!.post as any).parameters as { in: string; name: string; required: boolean }[];
    const idem = params.filter((p) => p.in === 'header' && p.name.toLowerCase() === 'idempotency-key');
    expect(idem).toEqual([expect.objectContaining({ name: 'Idempotency-Key', required: true })]);
  });

  test('os exemplos de transação do documento são aceitos pela API', async () => {
    const examples = doc.paths['/wagering/transactions']!.post!.requestBody.content['application/json'].examples;
    expect(Object.keys(examples).sort()).toEqual(['BET', 'LOSS', 'REFUND', 'ROLLBACK', 'WIN']);
    const walletExample = doc.paths['/wallets']!.post!.requestBody.content['application/json'].examples.BRL.value;
    const w = await http('POST', `${url}/wallets`, { ...walletExample, playerId: randomUUID() });
    expect(w.status).toBe(201);

    const suffix = randomUUID().slice(0, 8);
    const send = (name: string) => {
      const value = { ...examples[name].value, walletId: w.body.id, playerId: w.body.playerId };
      value.externalTransactionId += `-${suffix}`;
      if (value.referenceExternalTransactionId) value.referenceExternalTransactionId += `-${suffix}`;
      return submit(url, value);
    };
    // Em sequência, como alguém testando pela página.
    expect((await send('BET')).body).toMatchObject({ status: 'PROCESSED', balance: { amount: '75.00' } });
    expect((await send('WIN')).body).toMatchObject({ status: 'PROCESSED', balance: { amount: '135.00' } });
    expect((await send('LOSS')).body).toMatchObject({ status: 'PROCESSED', balance: { amount: '135.00' } });
    expect((await send('REFUND')).body).toMatchObject({ status: 'PROCESSED', balance: { amount: '160.00' } });
    // Como o próprio exemplo avisa: a BET já foi revertida pelo REFUND.
    expect((await send('ROLLBACK')).body).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_ALREADY_REVERSED' });
  });
});

describe('exemplos de resposta do documento', () => {
  const responses = (path: string, method: string) => doc.paths[path]![method]!.responses as Record<string, any>;
  const example = (path: string, method: string, statusCode: string) => responses(path, method)[statusCode].content['application/json'].example;

  test('cada status da submissão tem um exemplo coerente com o seu significado', () => {
    const path = '/wagering/transactions';
    expect(example(path, 'post', '201')).toMatchObject({ status: 'PROCESSED', idempotentReplay: false });
    expect(example(path, 'post', '201').failureCode).toBeUndefined();
    expect(example(path, 'post', '200')).toMatchObject({ status: 'PROCESSED', idempotentReplay: true });
    expect(example(path, 'post', '202')).toMatchObject({ status: 'PENDING_REFERENCE' });
    expect(example(path, 'post', '409').error.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
    expect(example(path, 'post', '400').error.code).toBe('VALIDATION_ERROR');
    expect(example(path, 'post', '503').error.code).toBe('TRANSIENT_FAILURE');
    const rejected = responses(path, 'post')['422'].content['application/json'].examples;
    expect(rejected.rejeitada.value).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS' });
    expect(rejected.walletInexistente.value.error.code).toBe('WALLET_NOT_FOUND');
  });

  test('os códigos de erro dos exemplos batem com o endpoint', () => {
    expect(example('/wallets', 'post', '409').error.code).toBe('WALLET_ALREADY_EXISTS');
    expect(example('/wallets/{walletId}', 'get', '404').error.code).toBe('WALLET_NOT_FOUND');
    expect(example('/wagering/transactions/{transactionId}', 'get', '404').error.code).toBe('TRANSACTION_NOT_FOUND');
  });

  test('PENDING não aparece como status possível de resposta (a API nunca o devolve)', () => {
    const json = JSON.stringify(doc.paths);
    expect(json).not.toContain('"PENDING"');
  });

  test('todos os exemplos obedecem aos schemas de saída', () => {
    for (const ex of Object.values(RESPONSE_EXAMPLES.submit)) conforms(submitResponse, ex);
    conforms(walletResponse, RESPONSE_EXAMPLES.wallet);
    conforms(transactionResponse, RESPONSE_EXAMPLES.transaction);
    conforms(ledgerResponse, RESPONSE_EXAMPLES.ledger);
    conforms(reconciliationResponse, RESPONSE_EXAMPLES.reconciliation);
    conforms(readinessResponse, RESPONSE_EXAMPLES.ready);
    conforms(readinessResponse, RESPONSE_EXAMPLES.notReady);
    // Todo exemplo de erro publicado no documento tem o formato de erro.
    for (const methods of Object.values(doc.paths)) {
      for (const op of Object.values(methods)) {
        for (const [code, resp] of Object.entries(op.responses as Record<string, any>)) {
          const content = resp.content?.['application/json'];
          const values = [content?.example, ...Object.values(content?.examples ?? {}).map((e: any) => e.value)].filter(Boolean);
          for (const v of values) {
            if (Number(code) >= 400 && v.error) conforms(errorResponse, v);
          }
        }
      }
    }
  });
});

describe('as respostas reais obedecem aos schemas documentados', () => {
  test('wallet, submissão (201, 200, 202, 422), consultas, ledger, reconciliação e erros', async () => {
    const created = await http('POST', `${url}/wallets`, { playerId: randomUUID(), initialBalance: { amount: '50.00', currency: 'BRL' } });
    expect(created.status).toBe(201);
    conforms(walletResponse, created.body);
    const w = created.body;
    conforms(walletResponse, (await http('GET', `${url}/wallets/${w.id}`)).body);

    const base = { playerId: w.playerId, walletId: w.id };
    const bet = wagerBody({ ...base, kind: 'BET', amount: '10.00' });
    const processed = await submit(url, bet);
    expect(processed.status).toBe(201);
    conforms(submitResponse, processed.body);

    const replay = await submit(url, bet);
    expect(replay.status).toBe(200);
    conforms(submitResponse, replay.body);

    const pending = await submit(url, wagerBody({ ...base, kind: 'ROLLBACK', amount: '5.00', referenceExternalTransactionId: `ainda-nao-${randomUUID()}` }));
    expect(pending.status).toBe(202);
    conforms(submitResponse, pending.body);

    const rejected = await submit(url, wagerBody({ ...base, kind: 'BET', amount: '999.00' }));
    expect(rejected.status).toBe(422);
    conforms(submitResponse, rejected.body);

    conforms(transactionResponse, (await http('GET', `${url}/wagering/transactions/${processed.body.transactionId}`)).body);
    conforms(transactionResponse, (await http('GET', `${url}/wagering/transactions/${pending.body.transactionId}`)).body);
    conforms(transactionResponse, (await http('GET', `${url}/providers/${bet.providerId}/wagering/transactions/${bet.externalTransactionId}`)).body);

    const ledger = await http('GET', `${url}/wallets/${w.id}/ledger?limit=1`);
    conforms(ledgerResponse, ledger.body);
    expect(ledger.body.nextCursor).not.toBeNull();
    conforms(reconciliationResponse, (await http('POST', `${url}/wallets/${w.id}/reconciliation`)).body);
    conforms(readinessResponse, (await http('GET', `${url}/health/ready`)).body);

    // Formato de erro: 400, 404, 409 e 422 sem transação.
    const errors = [
      await http('POST', `${url}/wagering/transactions`, bet), // sem Idempotency-Key: 400
      await http('GET', `${url}/wallets/${randomUUID()}`), // 404
      await submit(url, { ...bet, money: { amount: '11.00', currency: 'BRL' } }, `${bet.providerId}:${bet.externalTransactionId}`), // 409
      await submit(url, wagerBody({ playerId: randomUUID(), walletId: randomUUID(), kind: 'BET', amount: '1.00' })), // 422
    ];
    expect(errors.map((e) => e.status)).toEqual([400, 404, 409, 422]);
    for (const e of errors) conforms(errorResponse, e.body);
  });
});
