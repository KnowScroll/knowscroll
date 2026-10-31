import { NO_COLLECTION, readCollection, type AccountScope, type Collection } from '@knowscroll/client-core';

/**
 * What the Universe holds of the person's play: landmarks, this week's Orbit and the next Part to
 * resume (D-084, D-087, D-089, D-215). `ready` once any part has been read; a later failed read keeps
 * what was shown, so a dropped connection never empties the tray.
 */
export interface CollectionState {
  readonly status: 'idle' | 'loading' | 'ready' | 'unavailable';
  readonly collection: Collection;
}
export const NO_COLLECTION_STATE: CollectionState = { status: 'idle', collection: NO_COLLECTION };

/**
 * Reads the collection for the person's own Universe and keeps only the newest answer. It reads when
 * the screen comes to the front (a Scroll finished elsewhere shows at once) and when the map's
 * geography changes (a planet that has just formed takes the landmarks that were waiting for it).
 * Never used for a friend's universe: a visitor's session has no reader, and nothing here is shared.
 */
export function createCollectionReader(options: {
  readonly scope: AccountScope;
  readonly live: () => boolean;
  readonly current: () => CollectionState;
  readonly publish: (state: CollectionState) => void;
}) {
  let controller: AbortController | undefined;
  let seenRevision = -1;
  const read = async () => {
    if (!options.live()) return;
    controller?.abort();
    const mine = (controller = new AbortController());
    const previous = options.current().collection;
    options.publish({ status: 'loading', collection: previous });
    const result = await readCollection(options.scope, mine.signal, previous);
    if (mine.signal.aborted || !options.live()) return;
    options.publish(
      result.status === 'ready'
        ? { status: 'ready', collection: result.collection }
        : { status: 'unavailable', collection: previous },
    );
  };
  return {
    /** The screen came to the front. */
    refresh() {
      void read();
    },
    /** Call with each read's geography revision; reads again only when it changed. */
    seeGeography(revision: number) {
      if (revision === seenRevision) return;
      seenRevision = revision;
      void read();
    },
    stop() {
      controller?.abort();
    },
  };
}
