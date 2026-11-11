/**
 * The seeded readers of the post-deploy canary (#674, D-413). A persona is a way of using the product, not a
 * person: each one gets its own disposable account and uses only the public routes, so what it meets is what a
 * real reader would meet. Pure: no clock, no I/O.
 */

export const PERSONA_IDS = ['cold-start', 'deep-reader', 'topic-switcher', 'reel-watcher', 'many-reads'] as const;
export type PersonaId = (typeof PERSONA_IDS)[number];

export interface PersonaPlan {
  readonly id: PersonaId;
  /** One line for the runbook: what this reader does and what it proves. */
  readonly summary: string;
  /** The most encounters it opens in all (a glance at an offer counts). */
  readonly encounters: number;
  /**
   * The share of each Scroll's estimated reading time it spends, before `--speed`: 1 reads at the pace the
   * Scroll's own measures assume. A Reel is watched for at least `REEL_WATCH_FLOOR` of its length.
   */
  readonly readShare: number;
}

/** Defaults a persona runs with. `--many <n>` replaces the encounters of the reader of many Scrolls. */
export const DEFAULT_MANY_READS = 18;
export const MAX_MANY_READS = 60;

const PLANS: Readonly<Record<PersonaId, PersonaPlan>> = {
  'cold-start': {
    id: 'cold-start',
    summary: 'A brand-new account reads what it is offered first, then moves once.',
    encounters: 2,
    readShare: 1,
  },
  'deep-reader': {
    id: 'deep-reader',
    summary: 'Follows one Scroll series part by part, so its system and planet are due.',
    encounters: 4,
    readShare: 1,
  },
  'topic-switcher': {
    id: 'topic-switcher',
    summary: 'Reads a series, then deliberately opens a region of the place it formed.',
    encounters: 5,
    readShare: 0.8,
  },
  'reel-watcher': {
    id: 'reel-watcher',
    summary: 'Prefers Reels: switches to the Reel of what it is offered and keeps moving in Reels.',
    encounters: 4,
    readShare: 0.75,
  },
  'many-reads': {
    id: 'many-reads',
    summary: 'Skims many Scrolls in one sitting: no re-reads, and a Planner past 16 topics where the library allows.',
    encounters: DEFAULT_MANY_READS,
    readShare: 0.55,
  },
};

export function personaPlan(id: PersonaId, options: { readonly manyReads?: number } = {}): PersonaPlan {
  const plan = PLANS[id];
  return id === 'many-reads' && options.manyReads !== undefined ? { ...plan, encounters: options.manyReads } : plan;
}

/**
 * The address of one persona's disposable account for one run: the operator pattern's `*` replaced by
 * `canary-<run>-<persona>`, so it is unique per run and inside the pattern. `undefined` for a pattern with no
 * single `*` in its local part, which cannot make a unique address.
 */
export function canaryAddressFor(pattern: string, runId: string, persona: PersonaId): string | undefined {
  const at = pattern.lastIndexOf('@');
  if (at < 1) return undefined;
  const [prefix, suffix, extra] = pattern.slice(0, at).split('*');
  if (prefix === undefined || suffix === undefined || extra !== undefined) return undefined;
  return `${prefix}canary-${runId}-${persona}${suffix}${pattern.slice(at)}`.toLowerCase();
}

/** `a,b` → the personas in the given order, no repeats; `undefined` when one is unknown or none is named. */
export function parsePersonas(raw: string | undefined): readonly PersonaId[] | undefined {
  if (raw === undefined) return PERSONA_IDS;
  const named = raw.split(',').map((part) => part.trim());
  const known = named.filter((part): part is PersonaId => (PERSONA_IDS as readonly string[]).includes(part));
  if (known.length !== named.length || known.length === 0) return undefined;
  return [...new Set(known)];
}

/** The reading pace: the Scroll's own pace, a multiple of it, or the quickest an honest reader can go. */
export type Speed =
  { readonly kind: 'persona' } | { readonly kind: 'factor'; readonly value: number } | { readonly kind: 'max' };

export const MAX_SPEED_FACTOR = 60;

/** `1`..`60` or `max`; absent keeps each persona's own pace. `undefined` for anything else. */
export function parseSpeed(raw: string | undefined): Speed | undefined {
  if (raw === undefined) return { kind: 'persona' };
  if (raw === 'max') return { kind: 'max' };
  if (!/^[1-9][0-9]?$/.test(raw)) return undefined;
  const value = Number(raw);
  return value >= 1 && value <= MAX_SPEED_FACTOR ? { kind: 'factor', value } : undefined;
}

/**
 * The least share of a stop's nominal reading time an honest reader spends on it. Qualification counts a stop as
 * read after 40% of the time its words take (`STOP_READ_SHARE`); this leaves a margin, so the quickest persona
 * still reads. The server also bounds every claim by the wall time since activation, so speed shortens how long
 * the reader reads, never how long the canary waits for it.
 */
export const FASTEST_HONEST_SHARE = 0.5;

/** A Reel counts as watched at 60% of its length; the canary never reports less than this. */
export const REEL_WATCH_FLOOR = 0.7;

/** The share of a Scroll's nominal reading time the persona spends under the chosen speed. */
export function readShareFor(personaShare: number, speed: Speed): number {
  switch (speed.kind) {
    case 'persona':
      return Math.max(FASTEST_HONEST_SHARE, Math.min(1, personaShare));
    case 'max':
      return FASTEST_HONEST_SHARE;
    case 'factor':
      return Math.max(FASTEST_HONEST_SHARE, Math.min(1, personaShare / speed.value));
  }
}

/** The share of a Reel's length the persona watches under the chosen speed. */
export function watchShareFor(personaShare: number, speed: Speed): number {
  switch (speed.kind) {
    case 'persona':
      return Math.max(REEL_WATCH_FLOOR, Math.min(1, personaShare));
    case 'max':
      return REEL_WATCH_FLOOR;
    case 'factor':
      return Math.max(REEL_WATCH_FLOOR, Math.min(1, personaShare / speed.value));
  }
}
