import { BlockState, LIMITS, utf8ByteLength } from '@knowscroll/scroll-model';
import type { ScopedStorage } from '../account-scope';

/**
 * The key of a block's state: article revision plus the block's stable id (blueprint §18). The
 * same shape `@knowscroll/ui` declares for its `ScrollBlockStateStore`; the two are structurally
 * identical, so the app passes this store to `ScrollArticle` without a dependency between the
 * packages.
 */
export interface ScrollBlockKey {
  readonly assetId: string;
  readonly revision: number;
  readonly blockId: string;
}

export interface EarlierBlockState {
  readonly revision: number;
  readonly state: BlockState;
}

export interface ScrollBlockStateStore {
  get(key: ScrollBlockKey): BlockState | null;
  set(key: ScrollBlockKey, state: BlockState): void;
  clear(key: ScrollBlockKey): void;
  earlier(key: ScrollBlockKey): EarlierBlockState | null;
}

const PREFIX = 'scroll.block.';
/** Revisions of one block whose state is kept; older ones are forgotten as newer ones arrive. */
const KEPT_REVISIONS = 4;

const stateKey = (key: ScrollBlockKey) => `${PREFIX}${key.assetId}.${key.revision}.${key.blockId}`;
const indexKey = (key: Pick<ScrollBlockKey, 'assetId' | 'blockId'>) => `${PREFIX}index.${key.assetId}.${key.blockId}`;

function readRevisions(storage: ScopedStorage, key: ScrollBlockKey): number[] {
  const raw = storage.get(indexKey(key));
  if (raw === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is number => Number.isInteger(value)) : [];
  } catch {
    return [];
  }
}

function readState(storage: ScopedStorage, key: ScrollBlockKey): BlockState | null {
  const raw = storage.get(stateKey(key));
  if (raw === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    storage.remove(stateKey(key));
    return null;
  }
  const state = BlockState.safeParse(parsed);
  if (state.success) return state.data;
  // A value another build wrote, or storage that was edited: never trusted, forgotten.
  storage.remove(stateKey(key));
  return null;
}

/**
 * Block state kept on the device for the signed-in scope, by (assetId, revision, blockId). It
 * lives in the AccountScope's own `storage`, so it is purged when the scope ends (sign-out,
 * account switch, privacy reset) and never survives into another account. Values are only the
 * package's `BlockState` shapes (simulation parameter values, diagram frame, sequence step,
 * disclosure expanded), read back through the schema, never trusted as stored. Personal
 * simulation values stay here: nothing in this store is sent anywhere, and a snippet carries one
 * only when its sender explicitly includes it (`buildBlockStateSnapshot`).
 */
export function createScopedBlockStateStore(storage: ScopedStorage): ScrollBlockStateStore {
  const group = (work: () => void) => (storage.durability ? storage.durability.group(work) : work());
  return {
    get: (key) => readState(storage, key),
    set(key, state) {
      group(() => {
        const serialised = JSON.stringify(state);
        // A state larger than a snapshot may ever be is not one the package produces: ignore it.
        if (utf8ByteLength(serialised) > LIMITS.blockStateBytes) return;
        storage.set(stateKey(key), serialised);
        const revisions = [...new Set([...readRevisions(storage, key), key.revision])].sort((a, b) => a - b);
        for (const dropped of revisions.slice(0, Math.max(0, revisions.length - KEPT_REVISIONS))) {
          storage.remove(stateKey({ ...key, revision: dropped }));
        }
        storage.set(indexKey(key), JSON.stringify(revisions.slice(-KEPT_REVISIONS)));
      });
    },
    clear(key) {
      group(() => {
        storage.remove(stateKey(key));
        const remaining = readRevisions(storage, key).filter((revision) => revision !== key.revision);
        if (remaining.length === 0) storage.remove(indexKey(key));
        else storage.set(indexKey(key), JSON.stringify(remaining));
      });
    },
    earlier(key) {
      const older = readRevisions(storage, key)
        .filter((revision) => revision < key.revision)
        .sort((a, b) => b - a);
      for (const revision of older) {
        const state = readState(storage, { ...key, revision });
        if (state !== null) return { revision, state };
      }
      return null;
    },
  };
}
