import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../config';
import { mikroOrmConfig } from './mikro-orm.config';

/**
 * Uso: bun run src/infrastructure/persistence/migrate.ts up|down|reset
 *   up    aplica migrations pendentes
 *   down  reverte a última migration
 *   reset reverte todas e aplica de novo (usado nos testes de integração)
 */
export async function migrate(command: 'up' | 'down' | 'reset', databaseUrl = loadConfig().databaseUrl) {
  const orm = await MikroORM.init(mikroOrmConfig(databaseUrl, 2));
  try {
    const migrator = orm.getMigrator();
    if (command === 'up') {
      await migrator.up();
    } else if (command === 'down') {
      await migrator.down();
    } else {
      await migrator.down({ to: 0 });
      await migrator.up();
    }
  } finally {
    await orm.close(true);
  }
}

if (import.meta.main) {
  const command = (process.argv[2] ?? 'up') as 'up' | 'down' | 'reset';
  migrate(command)
    .then(() => console.log(JSON.stringify({ level: 'info', msg: `migration ${command} concluída` })))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
