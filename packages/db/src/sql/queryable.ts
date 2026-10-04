import type pg from 'pg';

/** Anything a db function can run a statement on: a checked-out client or the pool. */
export type Queryable = Pick<pg.PoolClient, 'query'>;
