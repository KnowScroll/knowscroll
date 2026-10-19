import { erasureRegistry } from './infrastructure/erasure/registry.js';
import { evidenceErasure } from './modules/evidence/adapters/erasure.js';
import { experienceErasure } from './modules/experience/adapters/erasure.js';
import { reasoningErasure } from './reasoning/adapters/erasure.js';
import { receiptsErasure } from './infrastructure/receipts/erasure.js';

/**
 * Every personal store in the backend, in eraser order (rows that reference others first). The
 * schema inventory test fails when a table with a `universe_id` column is missing here.
 *
 * Not listed because they hold no per-universe rows: `identity.accounts`/`identity.universes`
 * (the personal root itself; account deletion is its own lifecycle) and `content.assets`
 * (shared content).
 */
export const personalStores = erasureRegistry([evidenceErasure, experienceErasure, reasoningErasure, receiptsErasure]);
