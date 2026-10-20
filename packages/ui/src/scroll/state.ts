import type { BlockState } from '@knowscroll/scroll-model';

/**
 * Block state is keyed by the revision of the article, so a new revision never reads an old
 * revision's values, and by the block's stable id (blueprint §18: "persist state by article
 * revision + block ID").
 */
export interface ScrollBlockKey {
  readonly assetId: string;
  readonly revision: number;
  readonly blockId: string;
}

/** The newest state kept for an earlier revision of the same block. */
export interface EarlierBlockState {
  readonly revision: number;
  readonly state: BlockState;
}

/**
 * Where a reader's block state lives. Values are only the package's own `BlockState` shapes
 * (simulation parameter values, diagram frame, sequence step, disclosure expanded), so nothing
 * else can be stored through it. Reads are synchronous: a store that persists loads before the
 * article mounts, so the first frame already shows the reader's own state.
 *
 * `createMemoryBlockStateStore` is the default (state lasts as long as the store). The
 * AccountScope-scoped persistent store is `createScopedBlockStateStore` in `@knowscroll/client-core`:
 * it is purged when the account scope ends, and personal simulation values never leave the device
 * unless a sender explicitly includes them in a snippet.
 */
export interface ScrollBlockStateStore {
  get(key: ScrollBlockKey): BlockState | null;
  set(key: ScrollBlockKey, state: BlockState): void;
  /** Forgets the state of one revision of one block (a reset). */
  clear(key: ScrollBlockKey): void;
  /** The newest state kept for this block under a revision older than `key.revision`, or null. */
  earlier(key: ScrollBlockKey): EarlierBlockState | null;
}

function entryKey(key: ScrollBlockKey): string {
  return `${key.assetId}\u0000${key.blockId}\u0000${key.revision}`;
}

/** The default store: in memory, per instance. */
export function createMemoryBlockStateStore(): ScrollBlockStateStore {
  const values = new Map<string, BlockState>();
  const revisions = new Map<string, Set<number>>();
  const blockKey = (key: ScrollBlockKey) => `${key.assetId}\u0000${key.blockId}`;
  return {
    get: (key) => values.get(entryKey(key)) ?? null,
    set(key, state) {
      values.set(entryKey(key), state);
      const seen = revisions.get(blockKey(key)) ?? new Set<number>();
      seen.add(key.revision);
      revisions.set(blockKey(key), seen);
    },
    clear(key) {
      values.delete(entryKey(key));
      revisions.get(blockKey(key))?.delete(key.revision);
    },
    earlier(key) {
      const older = [...(revisions.get(blockKey(key)) ?? [])].filter((revision) => revision < key.revision);
      const revision = Math.max(...older);
      if (older.length === 0) return null;
      const state = values.get(entryKey({ ...key, revision }));
      return state === undefined ? null : { revision, state };
    },
  };
}
