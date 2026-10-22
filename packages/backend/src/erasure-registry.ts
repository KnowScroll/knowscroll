import { checkErasureInventory } from './infrastructure/erasure/inventory.js';
import { clearCoreTransactionOf } from './infrastructure/postgres/privacy-scope.js';
import { socialErasure } from './modules/social/adapters/erasure.js';
import { scenesErasure } from './modules/scenes/adapters/erasure.js';
import { geographyErasure } from './modules/geography/adapters/erasure.js';
import { supplyErasure } from './modules/supply/adapters/erasure.js';
import { plannerErasure } from './modules/planner/adapters/erasure.js';
import { clearExplorationRegistry, erasureRegistry } from './infrastructure/erasure/registry.js';
import { composerErasure } from './modules/composer/adapters/erasure.js';
import { evidenceErasure } from './modules/evidence/adapters/erasure.js';
import { personalContextErasure } from './modules/personal-context/adapters/erasure.js';
import { experienceErasure } from './modules/experience/adapters/erasure.js';
import { identityErasure } from './modules/identity/adapters/erasure.js';
import { reasoningErasure } from './reasoning/adapters/erasure.js';
import { receiptsErasure } from './infrastructure/receipts/erasure.js';

/**
 * Every personal store in the backend, in eraser order (rows that reference others first). The
 * schema inventory test fails when a table with a `universe_id` column is missing here.
 *
 * Identity is listed last: its account-keyed tables (addresses, sign-in links, sessions) are
 * erased by account deletion, not by clearing a universe, and the inventory test fails when an
 * identity table is not declared. Not listed because they hold no personal rows of their own:
 * `identity.accounts`/`identity.universes` (the personal root itself; account deletion is its own
 * lifecycle) and `content.assets` (shared content).
 */
export const personalStores = erasureRegistry([
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
]);

/** Explicit order, with Social and Identity preserved. No full-eraser callback is used. */
const preservedSocial = {
  ...socialErasure,
  clearExploration: {
    dispositions: Object.fromEntries([
      ...socialErasure.tables.map((t) => [`${t.schema}.${t.table}`, 'preserve']),
      ...(socialErasure.accountTables ?? []).map((t) => [`${t.schema}.${t.table}`, 'preserve']),
      ...(socialErasure.accountColumns ?? []).map((t) => [`${t.schema}.${t.table}`, 'preserve']),
      ...socialErasure.nonRowStores.map((s) => [`store:${s.name}`, 'preserve']),
    ]) as Record<string, 'preserve'>,
    erase: () => Promise.resolve({ module: 'social', status: 'completed' as const, removed: 0 }),
  },
};
export const explorationStores = clearExplorationRegistry(
  [
    preservedSocial,
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
  ],
  personalStores,
  async (scope) => (await checkErasureInventory(clearCoreTransactionOf(scope), personalStores)).length === 0,
);
