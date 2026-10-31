/**
 * What the session needs to know about an animation that is playing, and nothing else: taps are ignored
 * while one plays, and Back, Up and Escape first jump it to its end frame (design: "Input while playing").
 * The session owns the gate; the screen that draws the animation registers how to finish it.
 */
export interface TransitionGate {
  /** An animation is playing. */
  readonly active: () => boolean;
  /** Jumps a playing animation to its end frame. Returns whether there was one. */
  readonly finish: () => boolean;
  /** The screen registers the playing animation's finisher, or `undefined` when it ends. */
  readonly set: (finisher: (() => void) | undefined) => void;
}

export function createTransitionGate(): TransitionGate {
  let finisher: (() => void) | undefined;
  return {
    active: () => finisher !== undefined,
    finish() {
      const current = finisher;
      if (current === undefined) return false;
      current();
      return true;
    },
    set(next) {
      finisher = next;
    },
  };
}

/** The methods of a map session a tap reaches. While an animation plays they do nothing. */
const IGNORED_WHILE_PLAYING = [
  'focus',
  'focusLast',
  'select',
  'land',
  'travel',
  'showOverlay',
  'camera',
  'fit',
  'setLately',
  'openRegion',
] as const;
/** The methods that go back up. While an animation plays they first jump it to its end frame. */
const FINISH_FIRST = ['back', 'up', 'escape'] as const;

type AnyMethod = (...args: never[]) => unknown;

/**
 * Gives a map session its gate (design: "Input while playing"): taps are ignored while an animation
 * plays, and Back, Up and Escape jump it to its end frame and then go back as normal. The screen that
 * draws the animation registers its finisher on `gate`.
 */
export function withTransitionGate<S extends object>(session: S): S & { readonly gate: TransitionGate } {
  const gate = createTransitionGate();
  const wrapped: Record<string, unknown> = { ...session, gate };
  const methods = session as unknown as Record<string, AnyMethod | undefined>;
  for (const name of IGNORED_WHILE_PLAYING) {
    const method = methods[name];
    if (method === undefined) continue;
    wrapped[name] = (...args: never[]) => (gate.active() ? false : method(...args));
  }
  for (const name of FINISH_FIRST) {
    const method = methods[name];
    if (method === undefined) continue;
    wrapped[name] = (...args: never[]) => {
      gate.finish();
      return method(...args);
    };
  }
  return wrapped as S & { readonly gate: TransitionGate };
}
