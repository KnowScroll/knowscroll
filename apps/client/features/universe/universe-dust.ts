import { readDustCues, type AccountScope } from '@knowscroll/client-core';
import type { DustCue } from '@knowscroll/client-core';

/** Dust cues of recent reading; a cue is not a place and is never a navigation target. */
export interface DustState {
  readonly status: 'idle' | 'loading' | 'ready' | 'unavailable';
  readonly cues: readonly DustCue[];
}
export const NO_DUST: DustState = { status: 'idle', cues: [] };

/**
 * Reads dust for the Universe view and keeps only the newest answer. A read starts when the map
 * first has a geography, when that geography's revision changes (a cue disappears once its system
 * is established), and when the screen comes back to the foreground.
 */
export function createDustReader(options: {
  readonly scope: AccountScope;
  readonly live: () => boolean;
  readonly current: () => DustState;
  readonly publish: (dust: DustState) => void;
}) {
  let controller: AbortController | undefined;
  let seenRevision = -1;
  const read = async () => {
    if (!options.live()) return;
    controller?.abort();
    const mine = (controller = new AbortController());
    const previous = options.current().cues;
    options.publish({ status: 'loading', cues: previous });
    const result = await readDustCues(options.scope, mine.signal);
    if (mine.signal.aborted || !options.live()) return;
    options.publish(
      result.status === 'ready' ? { status: 'ready', cues: result.cues } : { status: 'unavailable', cues: previous },
    );
  };
  return {
    /** Call with each read's geography revision; reads again only when it changed. */
    seeGeography(revision: number) {
      if (revision === seenRevision) return;
      seenRevision = revision;
      void read();
    },
    /** The screen came back: refresh, if a geography has been seen at all. */
    refreshIfStarted() {
      if (seenRevision >= 0) void read();
    },
    stop() {
      controller?.abort();
    },
  };
}
