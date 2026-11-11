import {
  BeforeApplicationShutdown,
  DynamicModule,
  Inject,
  Module,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { CreateWalletUseCase } from './application/create-wallet.use-case';
import { ProcessPendingReferencesUseCase } from './application/process-pending-references.use-case';
import { Clock, CLOCK, systemClock, UNIT_OF_WORK, UnitOfWork } from './application/ports';
import { WalletQueries } from './application/queries';
import { SubmitWagerTransactionUseCase } from './application/submit-wager-transaction.use-case';
import { WagerProcessor } from './application/wager-processor';
import { type AppConfig, APP_CONFIG } from './infrastructure/config';
import { OutboxPublisher } from './infrastructure/messaging/outbox-publisher';
import { createSqsClient, QueueUrls, SQS_CLIENT } from './infrastructure/messaging/sqs';
import { logger } from './infrastructure/observability/logger';
import { prometheusInstrumentation } from './infrastructure/observability/instrumentation';
import { mikroOrmConfig } from './infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from './infrastructure/persistence/mikro-orm-unit-of-work';
import { PendingReferenceWorker } from './infrastructure/workers/pending-reference-worker';
import { AllowAllProviderIdentity, PROVIDER_IDENTITY, ProviderAuthGuard } from './presentation/http/auth';
import { OpsController, WageringController, WalletsController } from './presentation/http/controllers';
import { HealthService } from './presentation/http/health.service';
import { HttpErrorsFilter } from './presentation/http/http-errors.filter';
import { CREATE_WALLET, HEALTH, SUBMIT_WAGER, WALLET_QUERIES } from './presentation/http/tokens';
import { WagerTransactionsConsumer } from './presentation/sqs/wager-transactions.consumer';

const QUEUE_URLS = Symbol('QUEUE_URLS');
const PROCESSOR = Symbol('PROCESSOR');

/** Inicia e encerra os processos de fundo junto com a aplicação. */
class BackgroundProcesses implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly consumer: WagerTransactionsConsumer,
    private readonly outbox: OutboxPublisher,
    private readonly pending: PendingReferenceWorker,
    private readonly orm: MikroORM,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.consumer.enabled) this.consumer.start();
    if (this.config.outbox.enabled) this.outbox.start();
    if (this.config.pendingReferences.enabled) this.pending.start();
  }

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    logger.info({ signal }, 'encerrando: parando consumidor e workers');
    const stopAll = Promise.all([this.consumer.stop(), this.outbox.stop(), this.pending.stop()]);
    const timeout = new Promise((resolve) => setTimeout(resolve, this.config.shutdownTimeoutMs, 'timeout'));
    if ((await Promise.race([stopAll, timeout])) === 'timeout') {
      logger.warn('shutdown excedeu o tempo limite; mensagens não confirmadas voltarão pela visibilidade da fila');
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close(true);
    logger.info('encerrado');
  }
}

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [WalletsController, WageringController, OpsController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: CLOCK, useValue: systemClock },
        {
          provide: MikroORM,
          useFactory: () => MikroORM.init(mikroOrmConfig(config.databaseUrl, config.dbPoolMax)),
        },
        {
          provide: UNIT_OF_WORK,
          inject: [MikroORM],
          useFactory: (orm: MikroORM) => new MikroOrmUnitOfWork(orm, config.lockTimeoutMs),
        },
        { provide: SQS_CLIENT, useFactory: () => createSqsClient(config) },
        { provide: QUEUE_URLS, inject: [SQS_CLIENT], useFactory: (sqs: SQSClient) => new QueueUrls(sqs) },
        {
          provide: PROCESSOR,
          useFactory: () => new WagerProcessor(config.pendingReferences, prometheusInstrumentation),
        },
        {
          provide: SUBMIT_WAGER,
          inject: [UNIT_OF_WORK, PROCESSOR, CLOCK],
          useFactory: (uow: UnitOfWork, p: WagerProcessor, clock: Clock) =>
            new SubmitWagerTransactionUseCase(uow, p, clock, prometheusInstrumentation),
        },
        {
          provide: CREATE_WALLET,
          inject: [UNIT_OF_WORK, CLOCK],
          useFactory: (uow: UnitOfWork, clock: Clock) => new CreateWalletUseCase(uow, clock, prometheusInstrumentation),
        },
        {
          provide: WALLET_QUERIES,
          inject: [UNIT_OF_WORK],
          useFactory: (uow: UnitOfWork) => new WalletQueries(uow, prometheusInstrumentation),
        },
        {
          provide: HEALTH,
          inject: [MikroORM, SQS_CLIENT, QUEUE_URLS],
          useFactory: (orm: MikroORM, sqs: SQSClient, q: QueueUrls) => new HealthService(orm, sqs, q, config),
        },
        {
          provide: WagerTransactionsConsumer,
          inject: [SUBMIT_WAGER, SQS_CLIENT, QUEUE_URLS],
          useFactory: (uc: SubmitWagerTransactionUseCase, sqs: SQSClient, q: QueueUrls) =>
            new WagerTransactionsConsumer(uc, sqs, q, config),
        },
        {
          provide: OutboxPublisher,
          inject: [UNIT_OF_WORK, SQS_CLIENT, QUEUE_URLS, CLOCK],
          useFactory: (uow: UnitOfWork, sqs: SQSClient, q: QueueUrls, clock: Clock) =>
            new OutboxPublisher(uow, sqs, q, config, clock),
        },
        {
          provide: PendingReferenceWorker,
          inject: [UNIT_OF_WORK, PROCESSOR, CLOCK],
          useFactory: (uow: UnitOfWork, p: WagerProcessor, clock: Clock) =>
            new PendingReferenceWorker(
              new ProcessPendingReferencesUseCase(uow, p, clock, prometheusInstrumentation),
              config,
            ),
        },
        { provide: PROVIDER_IDENTITY, useClass: AllowAllProviderIdentity },
        { provide: APP_GUARD, useClass: ProviderAuthGuard },
        { provide: APP_FILTER, useClass: HttpErrorsFilter },
        BackgroundProcesses,
      ],
    };
  }
}
