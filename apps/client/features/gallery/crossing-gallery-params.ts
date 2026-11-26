import type { CrossingDirection } from '../universe/crossing/crossing-frame';

/** What `/gallery-space?scene=crossing` reads from its address. */
export interface CrossingGalleryParams {
  /** Film time of the still, 0 to 1. */
  readonly q: number;
  readonly direction: CrossingDirection;
  /** The visited friend's first name. */
  readonly name: string;
  /** Systems you share, in order. Out only. */
  readonly shared: readonly string[];
  /** Play the film in real time instead of drawing one still. */
  readonly play: boolean;
  /** The friend was crossed to before: the shorter film. */
  readonly seen: boolean;
}

type Raw = Readonly<Record<string, string | string[] | undefined>>;

const first = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

/**
 * Reads `q`, `dir` (`out` or `home`), `name`, `shared` (comma separated), `play` and `seen` from the address, with
 * the prototype's own as defaults: Ravi, who shares Attention and Stars. A `q` that is not a number is 0.30.
 */
export function readCrossingParams(raw: Raw): CrossingGalleryParams {
  const q = Number(first(raw['q']));
  const name = first(raw['name'])?.trim();
  const shared = first(raw['shared']);
  return {
    q:
      Number.isFinite(q) && first(raw['q']) !== undefined && first(raw['q']) !== '' ? Math.min(1, Math.max(0, q)) : 0.3,
    direction: first(raw['dir']) === 'home' ? 'home' : 'out',
    name: name === undefined || name === '' ? 'Ravi' : name,
    shared:
      shared === undefined
        ? ['Attention', 'Stars']
        : shared
            .split(',')
            .map((entry) => entry.trim())
            .filter((entry) => entry !== ''),
    play: first(raw['play']) === '1',
    seen: first(raw['seen']) === '1',
  };
}
