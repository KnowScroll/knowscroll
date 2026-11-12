import type { Kysely } from 'kysely';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { makeCatalogue } from '@knowscroll/backend/modules/content/nest-providers';
import type { Catalogue } from '@knowscroll/backend/modules/content';

/**
 * The topic catalogue over a test database, as the services read it (D-419): the release the database holds, which is the seeded
 * one (the library plan) until a test makes another. It looks at the pointer on every read and waits for it, so a release a test
 * made a moment ago is read at once; production keeps a release for a few seconds.
 */
export const catalogueOf = (db: Kysely<Database>): Catalogue =>
  makeCatalogue(db, { revalidateMs: 0, background: false });
