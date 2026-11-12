import type { CatalogueSnapshot } from '../domain/catalogue/snapshot.js';

/**
 * Port: the topic catalogue (#674, D-419). It is data in Postgres, released in numbered steps, so a topic is added with no deploy.
 * A use case asks for one snapshot and reads everything of the catalogue from it, so a rule that looks twice never sees two
 * releases. Reads shared, nonpersonal tables on the process's pool, never inside a personal transaction's connection.
 */
export interface Catalogue {
  /**
   * The current release. The process keeps it and looks at the pointer again after a few seconds, so a release made by another
   * process is read without a restart; a read made inside a transaction never waits for that look.
   */
  current(): Promise<CatalogueSnapshot>;
  /**
   * An earlier release by number: what a run that pinned it reads for ever. `undefined` when there is no such release. A release the
   * process has read already is answered from memory, with no query, so this is safe inside a personal transaction.
   */
  release(releaseId: number): Promise<CatalogueSnapshot | undefined>;
}
