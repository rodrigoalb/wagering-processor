import { Migrator } from '@mikro-orm/migrations';
import { Options, PostgreSqlDriver } from '@mikro-orm/postgresql';
import { Migration20261111000001_initial_schema } from './migrations/Migration20261111000001_initial_schema';
import { ALL_SCHEMAS } from './records';

export function mikroOrmConfig(databaseUrl: string, poolMax = 10): Options {
  return {
    driver: PostgreSqlDriver,
    clientUrl: databaseUrl,
    entities: ALL_SCHEMAS,
    extensions: [Migrator],
    // Toda operação usa um fork explícito; o contexto global fica proibido.
    allowGlobalContext: false,
    pool: { min: 0, max: poolMax },
    debug: false,
    migrations: {
      tableName: 'mikro_orm_migrations',
      transactional: true,
      allOrNothing: true,
      // Lista explícita: dispensa glob/compilação e funciona igual no Bun e no Docker.
      migrationsList: [
        { name: 'Migration20261111000001_initial_schema', class: Migration20261111000001_initial_schema },
      ],
    },
  };
}
