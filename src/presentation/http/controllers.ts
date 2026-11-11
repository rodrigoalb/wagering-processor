import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { CreateWalletUseCase } from '../../application/create-wallet.use-case';
import { WalletQueries } from '../../application/queries';
import { SubmitWagerTransactionUseCase } from '../../application/submit-wager-transaction.use-case';
import { WagerTransactionKind, WagerTransactionStatus } from '../../domain/wager/wager-transaction';
import { metrics, registry } from '../../infrastructure/observability/metrics';
import { createWalletSchema, idempotencyKeySchema, ledgerQuerySchema, parse, wagerFieldsSchema } from '../contracts';
import { z } from 'zod';
import { Public } from './auth';
import { correlationIdOf } from './correlation.middleware';
import { CREATE_WALLET, HEALTH, SUBMIT_WAGER, WALLET_QUERIES } from './tokens';
import { HealthService } from './health.service';

const uuidParam = z.uuid();
const idParam = (value: string, name: string) => parse(z.object({ [name]: uuidParam }), { [name]: value })[name] as string;

@Controller('wallets')
export class WalletsController {
  constructor(
    @Inject(CREATE_WALLET) private readonly createWallet: CreateWalletUseCase,
    @Inject(WALLET_QUERIES) private readonly queries: WalletQueries,
  ) {}

  @Post()
  @HttpCode(201)
  create(@Body() body: unknown, @Req() req: Request) {
    return this.createWallet.execute(parse(createWalletSchema, body), correlationIdOf(req));
  }

  @Get(':walletId')
  get(@Param('walletId') walletId: string) {
    return this.queries.getWallet(idParam(walletId, 'walletId'));
  }

  @Get(':walletId/ledger')
  ledger(@Param('walletId') walletId: string, @Query() query: unknown) {
    const { cursor, limit } = parse(ledgerQuerySchema, query);
    return this.queries.getLedger(idParam(walletId, 'walletId'), cursor, limit);
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  reconcile(@Param('walletId') walletId: string) {
    return this.queries.reconcile(idParam(walletId, 'walletId'));
  }
}

/** Status HTTP da submissão conforme o resultado. Rejeição é 422 com o corpo do resultado. */
function submitStatus(status: WagerTransactionStatus, replay: boolean): number {
  switch (status) {
    case WagerTransactionStatus.Processed:
      return replay ? 200 : 201;
    case WagerTransactionStatus.PendingReference:
    case WagerTransactionStatus.Pending:
      return 202;
    case WagerTransactionStatus.Rejected:
      return 422;
    case WagerTransactionStatus.Failed:
      return 500;
  }
}

@Controller()
export class WageringController {
  constructor(
    @Inject(SUBMIT_WAGER) private readonly submit: SubmitWagerTransactionUseCase,
    @Inject(WALLET_QUERIES) private readonly queries: WalletQueries,
  ) {}

  @Post('wagering/transactions')
  async create(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const started = performance.now();
    try {
      const idempotencyKey = parse(z.object({ 'Idempotency-Key': idempotencyKeySchema }), {
        'Idempotency-Key': idempotencyKeyHeader,
      })['Idempotency-Key'];
      const fields = parse(wagerFieldsSchema, body);
      const result = await this.submit.execute(
        { ...fields, kind: fields.kind as WagerTransactionKind, idempotencyKey },
        { source: 'http', correlationId: correlationIdOf(req), causationId: idempotencyKey },
      );
      res.status(submitStatus(result.status, result.idempotentReplay));
      return result;
    } finally {
      metrics.processingLatency.observe({ source: 'http' }, (performance.now() - started) / 1000);
    }
  }

  @Get('wagering/transactions/:transactionId')
  get(@Param('transactionId') transactionId: string) {
    return this.queries.getTransaction(idParam(transactionId, 'transactionId'));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  getByExternal(@Param('providerId') providerId: string, @Param('externalTransactionId') externalTransactionId: string) {
    return this.queries.getTransactionByExternalId(providerId, externalTransactionId);
  }
}

@Public()
@Controller()
export class OpsController {
  constructor(@Inject(HEALTH) private readonly health: HealthService) {}

  @Get('health/live')
  live() {
    return { status: 'ok' };
  }

  @Get('health/ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const report = await this.health.readiness();
    res.status(report.status === 'ok' ? 200 : 503);
    return report;
  }

  @Get('metrics')
  async metrics(@Res() res: Response) {
    res.setHeader('Content-Type', registry.contentType);
    res.send(await registry.metrics());
  }
}
