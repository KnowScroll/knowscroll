/**
 * Opening at a kept place while the page settles. Figures draw and holds measure themselves over several frames, moving
 * the place's beat; the reader keeps bringing it back until the person scrolls, touches the page or presses a key, or
 * `release` is called. Only the person's own input lets the place go: the page moving under it (a hold measuring itself,
 * the browser keeping its own scroll anchor) also scrolls, and must not.
 */
export interface KeptPlace {
  readonly holding: () => boolean;
  /** Whether the scroller, now at `at`, needs moving to `y`. */
  readonly ask: (y: number, at: number) => boolean;
  readonly release: () => void;
}

export function createKeptPlace(active: boolean): KeptPlace {
  let holding = active;
  return {
    holding: () => holding,
    ask: (y, at) => Math.abs(at - y) >= 1,
    release() {
      holding = false;
    },
  };
}
