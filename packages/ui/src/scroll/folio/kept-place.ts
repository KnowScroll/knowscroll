/**
 * A beat kept in place while the page settles: at the opening, a kept place; later, the beat being read when the text
 * version reflows the essay. Figures draw and holds measure themselves over several frames, moving the beat; the reader
 * keeps bringing it back until the person scrolls, touches the page or presses a key, or `release` is called. Only the
 * person's own input lets the place go: the page moving under it (a hold measuring itself, the browser keeping its own
 * scroll anchor) also scrolls, and must not.
 */
export interface KeptPlace {
  /** The stop being kept, while it is kept. */
  readonly stop: () => string | undefined;
  readonly holding: () => boolean;
  /** Keeps this stop in place again, from now until the page settles or the person acts. */
  readonly keep: (stopId: string) => void;
  /** Whether the scroller, now at `at`, needs moving to `y`. */
  readonly ask: (y: number, at: number) => boolean;
  readonly release: () => void;
}

export function createKeptPlace(stopId: string | undefined): KeptPlace {
  let kept = stopId;
  return {
    stop: () => kept,
    holding: () => kept !== undefined,
    keep(next) {
      kept = next;
    },
    ask: (y, at) => Math.abs(at - y) >= 1,
    release() {
      kept = undefined;
    },
  };
}
