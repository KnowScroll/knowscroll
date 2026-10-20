import type { ReadingObserver, ScopedStorage } from '@knowscroll/client-core';

/** Remembers where in an article the person was, and gives it back when they return (E02 "Restore"). */
export interface AnchorKeeper {
  /** Watches visibility; satisfies the renderer's observer (the other two events are not its business). */
  readonly observer: ReadingObserver;
  /** The block to restore to (its ID), if one was remembered for this revision and still exists. */
  restore(): string | undefined;
}

/** The storage key of the resume anchor of one article revision (inside the account scope's prefix). */
export function anchorKey(assetId: string, revision: number): string {
  return `scroll.anchor.${assetId}.${String(revision)}`;
}

/**
 * Keeps the resume anchor: the **block ID** at the top of the reading viewport, by article revision
 * (blueprint §18 "URLs contain stable identity ... Local resume records contain scroll positions";
 * E02: the anchor is the block, not a pixel offset). It lives in the account scope's storage, so
 * sign-out, an account switch or a privacy reset removes it with the rest of the scope. A new
 * revision has its own key: an old anchor never points into a different document.
 *
 * `order` is the document's top-level block IDs in reading order; the anchor is the first block in
 * it that is at least a tenth visible. Writes only when the anchor changes.
 */
export function createAnchorKeeper(options: {
  readonly assetId: string;
  readonly revision: number;
  readonly order: readonly string[];
  readonly storage: Pick<ScopedStorage, 'get' | 'set'>;
}): AnchorKeeper {
  const key = anchorKey(options.assetId, options.revision);
  const fractions = new Map<string, number>();
  let current: string | undefined;
  const known = new Set(options.order);
  return {
    observer: {
      onBlockVisibility(event) {
        if (!known.has(event.blockId)) return;
        fractions.set(event.blockId, event.visibleFraction);
        const top = options.order.find((id) => (fractions.get(id) ?? 0) >= 0.1);
        if (top !== undefined && top !== current) {
          current = top;
          options.storage.set(key, top);
        }
      },
      onBlockInteraction() {},
      onActivity() {},
    },
    restore() {
      const stored = options.storage.get(key);
      return stored !== undefined && known.has(stored) ? stored : undefined;
    },
  };
}

/** Calls every observer with each event, in order; one throwing observer never starves the others. */
export function combineObservers(...observers: readonly ReadingObserver[]): ReadingObserver {
  const each = (call: (observer: ReadingObserver) => void): void => {
    for (const observer of observers) {
      try {
        call(observer);
      } catch {
        // An observer's failure is its own; reading goes on.
      }
    }
  };
  return {
    onBlockVisibility: (event) => each((observer) => observer.onBlockVisibility(event)),
    onBlockInteraction: (event) => each((observer) => observer.onBlockInteraction(event)),
    onActivity: (event) => each((observer) => observer.onActivity(event)),
  };
}
