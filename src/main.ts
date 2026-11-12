import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadConfig } from './infrastructure/config';
import { logger, setLogInstanceId } from './infrastructure/observability/logger';
import { correlationMiddleware } from './presentation/http/correlation.middleware';

export async function bootstrap(config = loadConfig()) {
  setLogInstanceId(config.instanceId);
  const app = await NestFactory.create(AppModule.forRoot(config), { logger: ['error', 'warn'], bodyParser: true });
  app.use(correlationMiddleware);
  // SIGTERM/SIGINT disparam beforeApplicationShutdown: consumidor e workers param com elegância.
  app.enableShutdownHooks();
  await app.listen(config.port);
  logger.info({ port: config.port }, 'wagering-processor no ar');
  return app;
}

if (import.meta.main) {
  bootstrap().catch((err) => {
    logger.fatal({ err: (err as Error).message, stack: (err as Error).stack }, 'falha ao iniciar');
    process.exit(1);
  });
}
