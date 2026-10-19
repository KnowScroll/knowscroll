import type { Kysely } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
import {
  READ_ACCOUNT_UNIVERSE,
  READ_UNIVERSE_ACCESS,
  type ReadAccountUniverse,
  type ReadUniverseAccess,
} from '../public.js';
import { readAccountUniverse, readUniverseAccess } from './postgres-store.js';

/** Reusable outer wiring (blueprint §22): identity's read ports. Composition roots only. */
export function identityProviders(tokens: { readonly database: symbol }) {
  return [
    {
      provide: READ_ACCOUNT_UNIVERSE,
      inject: [tokens.database],
      useFactory:
        (db: Kysely<Database>): ReadAccountUniverse =>
        (accountId) =>
          readAccountUniverse(db, accountId),
    },
    {
      provide: READ_UNIVERSE_ACCESS,
      inject: [tokens.database],
      useFactory:
        (db: Kysely<Database>): ReadUniverseAccess =>
        (accountId, universeId) =>
          readUniverseAccess(db, accountId, universeId),
    },
  ];
}
