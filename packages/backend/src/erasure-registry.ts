import { checkErasureInventory } from './infrastructure/erasure/inventory.js';
import { clearExplorationRegistry, eraseExploration, erasureRegistry } from './infrastructure/erasure/registry.js';
import { clearCoreTransactionOf, markCurrentClearRemovalVerified } from './infrastructure/postgres/privacy-scope.js';
import type { ClearCoreTx } from './modules/identity/public.js';
import { composerErasure } from './modules/composer/adapters/erasure.js';
import { evidenceErasure } from './modules/evidence/adapters/erasure.js';
import { experienceErasure } from './modules/experience/adapters/erasure.js';
import { geographyErasure } from './modules/geography/adapters/erasure.js';
import { identityErasure } from './modules/identity/adapters/erasure.js';
import { personalContextErasure } from './modules/personal-context/adapters/erasure.js';
import { plannerErasure } from './modules/planner/adapters/erasure.js';
import { scenesErasure } from './modules/scenes/adapters/erasure.js';
import { socialErasure } from './modules/social/adapters/erasure.js';
import { supplyErasure } from './modules/supply/adapters/erasure.js';
import { reasoningErasure } from './reasoning/adapters/erasure.js';
import { receiptsErasure } from './infrastructure/receipts/erasure.js';

/**
 * The erasure registry: each module declares its personal stores in its own `adapters/erasure.ts`
 * (tables, owner columns, non-row stores, how full erasure and selective Clear treat each), and
 * this list composes them explicitly. A module that adds a personal store changes its own
 * declaration and nothing here; a module that adds a whole new set of stores adds one line.
 *
 * Order is eraser order: rows that reference others come first. Identity is last: its
 * account-keyed tables (addresses, sign-in links, sessions) are removed by account deletion, not
 * by clearing a universe, and its recording witness goes after everything it certified.
 *
 * Completeness is proved against the migrated schema, not by a digest: `checkErasureInventory`
 * fails when a table carrying a universe, account or person owner column is not declared, and it
 * also runs inside every Clear. `identity.accounts`, `identity.universes` (the personal roots)
 * and the shared content tables hold no personal rows of their own and are not listed.
 */
const moduleErasures = [
  socialErasure,
  scenesErasure,
  geographyErasure,
  supplyErasure,
  plannerErasure,
  personalContextErasure,
  evidenceErasure,
  experienceErasure,
  composerErasure,
  reasoningErasure,
  receiptsErasure,
  identityErasure,
];

/** Every personal store, for full erasure of one universe and for the schema inventory. */
export const personalStores = erasureRegistry(moduleErasures);

/**
 * The same stores with their selective-Clear dispositions. Each declares what Clear erases and
 * what it keeps (Saved items, friends, sign-in, financial records).
 */
export const explorationStores = clearExplorationRegistry(
  moduleErasures,
  personalStores,
  async (scope) => (await checkErasureInventory(clearCoreTransactionOf(scope), personalStores)).length === 0,
);

/**
 * Runs selective Clear's erasers over the real registry, inside the Clear core transaction, and
 * records that the real registry (not a test registry) did it. Only this proof lets Identity
 * install the new recording witness before releasing the Clear barrier.
 *
 * Failure: any eraser that does not report `completed`, or a schema that has an undeclared
 * personal table, throws before the proof is recorded; the transaction rolls back and Clear is
 * retried.
 */
export async function eraseCurrentExploration(scope: ClearCoreTx): Promise<void> {
  await eraseExploration(scope, explorationStores);
  markCurrentClearRemovalVerified(scope);
}
