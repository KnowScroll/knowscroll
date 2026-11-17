/**
 * Opening at a kept place while the page settles. Figures draw and holds measure themselves over several frames, moving
 * the place's beat; the reader keeps bringing it back until the person scrolls somewhere else or `release` is called.
 */
export interface KeptPlace {
  readonly holding: () => boolean;
  /** Records the offset the reader asks the scroller for; false when it is the offset already asked for. */
  readonly ask: (y: number) => boolean;
  /** A scroll to anywhere but the offset asked for is the person's: the place has done its job. */
  readonly scrolledTo: (y: number) => void;
  readonly release: () => void;
}

export function createKeptPlace(active: boolean): KeptPlace {
  let holding = active;
  let asked = 0;
  return {
    holding: () => holding,
    ask(y) {
      if (Math.abs(asked - y) < 1) return false;
      asked = y;
      return true;
    },
    scrolledTo(y) {
      if (Math.abs(y - asked) > 2) holding = false;
    },
    release() {
      holding = false;
    },
  };
}
