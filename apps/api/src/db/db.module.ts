import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { Pool, types } from 'pg';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema';
import { AppConfig, CONFIG } from '../config';

// numeric (OID 1700) ostaje string — nikada float.
types.setTypeParser(1700, (v) => v);

export type Db = NodePgDatabase<typeof schema>;
/** Tip transakcije (isti API kao Db). */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbOrTx = Db | Tx;

export const PG_POOL = Symbol('PG_POOL');
export const DB = Symbol('DB');

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [CONFIG],
      useFactory: (cfg: AppConfig) =>
        new Pool({ connectionString: cfg.databaseUrl, max: 20, application_name: 'pos-api' }),
    },
    {
      provide: DB,
      inject: [PG_POOL],
      useFactory: (pool: Pool) => drizzle(pool, { schema }),
    },
  ],
  exports: [PG_POOL, DB],
})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}
  async onApplicationShutdown() {
    await this.pool.end();
  }
}
