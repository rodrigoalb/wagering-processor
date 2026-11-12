# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) vindas de múltiplos provedores de jogos, por HTTP e por SQS. Continua correto com mensagens duplicadas, fora de ordem e processadas em paralelo por várias instâncias.

**Stack:** Bun 1.4, TypeScript estrito, NestJS 11, MikroORM 6, PostgreSQL 16, AWS SQS (LocalStack 4.12), Docker Compose, pino, Prometheus (prom-client), zod.

As decisões técnicas, trade-offs e limitações estão em **[ARCHITECTURE.md](ARCHITECTURE.md)**.

## Sumário

- [Pré-requisitos](#pré-requisitos)
- [Subir tudo com Docker Compose](#subir-tudo-com-docker-compose)
- [Rodar localmente com Bun](#rodar-localmente-com-bun)
- [Testes](#testes)
- [API](#api)
- [Mensagens SQS](#mensagens-sqs)
- [Configuração](#configuração)
- [Estrutura do projeto](#estrutura-do-projeto)

## Pré-requisitos

- **Docker** com Docker Compose v2.
- **Bun 1.x** (para rodar fora do Docker e para os testes): `curl -fsSL https://bun.sh/install | bash`.

Portas usadas no host: `5440` (PostgreSQL), `4570` (LocalStack), `3001` a `3003` (três instâncias da aplicação).

## Subir tudo com Docker Compose

```bash
docker compose up -d --build --wait
```

Sobe PostgreSQL, LocalStack (com as filas `wager-transactions.fifo`, `wager-transactions-dlq.fifo` e `wagering-events.fifo` criadas por `infra/localstack/init-queues.sh`), roda as migrations e inicia **três instâncias** da aplicação em `localhost:3001`, `3002` e `3003`, todas consumindo a mesma fila e o mesmo outbox.

```bash
curl localhost:3001/health/ready
```

Para derrubar tudo e apagar os dados:

```bash
docker compose down -v
```

## Rodar localmente com Bun

```bash
bun install
```

```bash
bun run infra:up
```

```bash
bun run migration:up
```

```bash
PORT=3000 bun run start
```

| Comando | O que faz |
|---|---|
| `bun run start` | Sobe a aplicação (API, consumidor SQS, publisher do outbox, worker de referências) |
| `bun run infra:up` / `bun run infra:down` | Sobe/derruba só PostgreSQL e LocalStack |
| `bun run migration:up` / `bun run migration:down` | Aplica / reverte a última migration |
| `bun run typecheck` | `tsc --noEmit` em modo estrito |
| `bun run test` | Todos os testes (unitários e integração) |
| `bun run test:unit` | Só unitários (sem infraestrutura) |
| `bun run test:integration` | Só integração (exige `bun run infra:up`) |

## Testes

```bash
bun run infra:up
```

```bash
bun run test
```

Os testes de integração usam o PostgreSQL e o LocalStack reais do compose: banco `wagering_test` (recriado pelas migrations a cada arquivo) e filas exclusivas por arquivo. Vários testes sobem a aplicação como **processos separados** e os matam com `SIGKILL`/`SIGTERM`. Resultado atual: **178 testes, 0 falhas**, cerca de 1 minuto (a suíte foi repetida 10 vezes seguidas, sempre verde).

Cobertura dos cenários obrigatórios da seção 13 do desafio:

| Cenário | Arquivo |
|---|---|
| Money, Wallet, regras de BET/WIN/LOSS/REFUND/ROLLBACK, conflito de moeda, idempotency key com payload divergente | `src/**/*.spec.ts` |
| Migrations e constraints | `test/schema.int.test.ts` |
| Atomicidade entre wallet, ledger, inbox e outbox | `test/atomicity.int.test.ts` |
| Inbox e redelivery; retry e DLQ; `messageId` reutilizado | `test/sqs-consumer.int.test.ts` |
| PostgreSQL indisponível (503 e recuperação); timeout de lock por HTTP e SQS | `test/resilience.int.test.ts` |
| Publishers concorrentes sobre o mesmo outbox | `test/outbox.int.test.ts` |
| Mesma aposta 50 vezes em paralelo; 100/80/80; wallets distintas; 3 processos; worker de pendentes com várias instâncias | `test/concurrency.int.test.ts` |
| Worker morto depois do commit e antes do ack; SIGTERM; reinício com consistência | `test/recovery.int.test.ts` |
| ROLLBACK/REFUND antes da referência | `test/wagering-api.int.test.ts` |
| Invariante `wallet.balance == saldo do ledger` | `afterAll` de todos os arquivos de integração |

## API

Todas as respostas de erro têm o formato `{ "error": { "code", "message", "details?" }, "correlationId" }`. O header `X-Correlation-Id` é aceito e devolvido. Mapeamento completo de status na [seção 12 do ARCHITECTURE.md](ARCHITECTURE.md#12-mapeamento-de-status-http).

| Método | Rota | Descrição |
|---|---|---|
| `POST` | `/wallets` | Cria wallet (saldo inicial > 0 gera OPENING + lançamento) |
| `GET` | `/wallets/:walletId` | Saldo e versão |
| `GET` | `/wallets/:walletId/ledger?cursor=&limit=50` | Ledger paginado (cursor opaco e estável) |
| `POST` | `/wallets/:walletId/reconciliation` | Saldo materializado x saldo do ledger |
| `POST` | `/wagering/transactions` | Submete transação (header `Idempotency-Key` obrigatório) |
| `GET` | `/wagering/transactions/:transactionId` | Consulta por id interno |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta por id do provedor |
| `GET` | `/health/live`, `/health/ready` | Liveness e readiness (PostgreSQL + SQS) |
| `GET` | `/metrics` | Métricas Prometheus |

Exemplo:

```bash
curl -s -X POST localhost:3001/wallets -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'
```

```bash
curl -s -X POST localhost:3001/wagering/transactions \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<id da wallet>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
```

```json
{ "transactionId": "...", "status": "PROCESSED", "balance": { "amount": "975.00", "currency": "BRL" }, "idempotentReplay": false }
```

REFUND e ROLLBACK levam `referenceExternalTransactionId`.

## Mensagens SQS

Fila `wager-transactions.fifo`, mesmo contrato do enunciado. Use o `walletId` como `MessageGroupId`.

```bash
docker compose exec localstack awslocal sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id <walletId> \
  --message-body '{"messageId":"msg-123","type":"WagerTransactionRequested","occurredAt":"2026-07-29T15:00:00.000Z","data":{"providerId":"provider-a","externalTransactionId":"transaction-123","idempotencyKey":"provider-a:transaction-123","playerId":"<playerId>","walletId":"<walletId>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}}'
```

Eventos de integração são publicados em `wagering-events.fifo`.

## Configuração

Variáveis principais (defaults em `src/infrastructure/config.ts`):

| Variável | Default | Descrição |
|---|---|---|
| `DATABASE_URL` | `postgres://wagering:wagering@localhost:5440/wagering` | PostgreSQL |
| `AWS_ENDPOINT_URL` | `http://localhost:4570` | LocalStack |
| `PORT` | `3000` | Porta HTTP |
| `INSTANCE_ID` | `hostname-pid` | Identifica a instância nos logs e no lease do outbox |
| `DB_LOCK_TIMEOUT_MS` | `5000` | Espera máxima pelo lock de uma wallet |
| `SQS_CONSUMER_ENABLED` / `OUTBOX_PUBLISHER_ENABLED` / `PENDING_REFERENCE_WORKER_ENABLED` | `true` | Liga cada papel da instância |
| `SQS_CONSUMER_CONCURRENCY` | `4` | Laços de recebimento por instância |
| `SQS_MAX_ATTEMPTS` | `5` | Tentativas antes da DLQ |
| `PENDING_REFERENCE_MAX_ATTEMPTS` | `10` | Tentativas antes de `REFERENCE_NOT_FOUND` |
| `PENDING_REFERENCE_BASE_DELAY_MS` / `_MAX_DELAY_MS` | `2000` / `120000` | Backoff das referências pendentes |
| `OUTBOX_LEASE_MS` | `30000` | Lease de um lote reivindicado |
| `SHUTDOWN_TIMEOUT_MS` | `20000` | Tempo máximo do shutdown gracioso |
| `LOG_LEVEL` | `info` | Nível do pino |

## Estrutura do projeto

```text
src/
  domain/            Money, Wallet, WagerTransaction, WalletLedgerEntry, Inbox/Outbox, eventos, regras
  application/       casos de uso, portas, payloadHash, retry
  infrastructure/    MikroORM (schemas, repositórios, migrations), SQS, outbox publisher, workers, logs, métricas
  presentation/      controllers HTTP, contratos, filtro de erros, auth (ponto de extensão), consumidor SQS
test/                testes de integração (PostgreSQL e LocalStack reais)
infra/               init das filas no LocalStack e do banco de teste
```
