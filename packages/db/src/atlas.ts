/**
 * The reader's places (ADR-0036, #134). Loads the Cartographer's inputs, applies its deltas under
 * the caller's universe lock, reads the atlas, and records the reader's rejections. Every place
 * change is written with its delta in the same transaction (the schema refuses anything else).
 * The entry module keeps the public face; `atlas/` holds the inputs, writes, read model, chronicle
 * and privacy functions.
 */

export {
  DELTA_PLACES,
  type DeltaNaming,
  deltaLines,
} from './atlas/chronicle.ts';
export { eraseAtlas, exportAtlas } from './atlas/privacy.ts';
export {
  type AtlasView,
  readAtlas,
  readAtlasDelta,
} from './atlas/read-model.ts';
export { rejectPlace, runCartographer, runKeeper } from './atlas/writes.ts';
