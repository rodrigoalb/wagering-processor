import { MikroORM } from '@mikro-orm/postgresql';
import { ConcurrencyConflictError, TransientInfrastructureError } from '../../application/errors';
import { TransactionalRepositories, UnitOfWork } from '../../application/ports';
import { classifyDbError } from './db-errors';
import { repositoriesFor } from './repositories';

/**
 * Unit of Work sobre `EntityManager.transactional()`. Cada execução usa um
 * fork próprio do EntityManager (identity map isolado por transação).
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    private readonly lockTimeoutMs: number,
  ) {}

  get read(): TransactionalRepositories {
    return repositoriesFor(this.orm.em.fork());
  }

  async run<T>(work: (repos: TransactionalRepositories) => Promise<T>): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(async (em) => {
        // Espera por lock de linha é limitada: hot wallet não segura conexões indefinidamente.
        await em.execute(`set local lock_timeout = ${Math.max(1, Math.floor(this.lockTimeoutMs))}`);
        return work(repositoriesFor(em));
      });
    } catch (err) {
      const cls = classifyDbError(err);
      switch (cls) {
        case 'connection':
          throw new TransientInfrastructureError('Banco de dados indisponível', err);
        case 'unique-violation':
        case 'deadlock':
        case 'serialization':
        case 'lock-timeout':
          throw new ConcurrencyConflictError((err as Error).message, cls);
        default:
          throw err;
      }
    }
  }
}
