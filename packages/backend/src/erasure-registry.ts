import { erasureRegistry } from './infrastructure/erasure/registry.js';
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
  personalContextErasure,
  evidenceErasure,
  experienceErasure,
  composerErasure,
  reasoningErasure,
  receiptsErasure,
  identityErasure,
]);
