import type { SimConfig } from './config.js';
import type { Library } from './library.js';
import type { Format, MoveKind, OfferView } from './model.js';
import type { ReadingKind } from './reading.js';
import type { Rng } from './rng.js';

/** What a persona may look at when it decides its next move: its own history and the library, never the system's internals. */
export interface StepContext {
  /** Encounters activated so far. */
  readonly index: number;
  readonly rng: Rng;
  readonly library: Library;
  readonly config: SimConfig;
  /** Explanations the person has met, in either format. */
  readonly met: ReadonlySet<string>;
  /** The format of the encounter the person is on, if any. */
  readonly format: Format | undefined;
  /** What the persona remembers between steps. */
  readonly memory: PersonaMemory;
  /** Whether the person has a formed region on their map to open. */
  readonly hasRegion: boolean;
}

export interface PersonaMemory {
  focusTopic?: string;
  regionsOpened: number;
  /** Topics the person has already been shown, for a reader who goes looking for somewhere new. */
  readonly seenTopics: Set<string>;
  /** Topics the person has reported at least a skim of (a quick open that reports nothing leaves no trace). */
  readonly touchedTopics: Set<string>;
  /** The last encounter was one the person had already met, so they leave it at once. */
  skipping?: boolean;
  /** Encounters since the person had met everything in the library. */
  afterEverything?: number;
  /** Encounters since the person had met every topic of the library. */
  afterEveryTopic?: number;
}

/**
 * A synthetic reader. It holds no logic of the product: it only decides what a person would do next
 * (which move, which offer, how to read it) from timings and preferences drawn from a seeded source.
 * Everything else, from which explanation is offered to whether a place forms, is the product's own
 * answer and is checked against the invariants afterwards.
 */
export interface PersonaSpec {
  readonly id: string;
  readonly title: string;
  /** Encounters this persona goes through in a run of the given size. */
  readonly encounters: (config: SimConfig, library: Library) => number;
  /** A session that ends on its own once this holds, before `encounters` runs out. */
  readonly until?: (context: StepContext) => boolean;
  /** The next move. Defaults to a vertical move that stays in the format the person is on. */
  readonly move?: (context: StepContext) => MoveKind;
  /**
   * Which of the offers a discovery returned to open. Defaults to the first the system chose. Returning nothing says none
   * suits, and the person taps "Somewhere new" again, up to `maxBrowses` times, before taking the first.
   */
  readonly choose?: (offers: readonly OfferView[], context: StepContext) => OfferView | undefined;
  readonly maxBrowses?: number;
  /**
   * A fixed list of links the person follows, one per encounter, instead of moves through Explore: a shared link or a
   * saved item opens exactly that explanation, in that format. Used where a scenario must be exact.
   */
  readonly script?: (library: Library) => readonly { readonly unitId: string; readonly kind: Format }[];
  /** How the person reads the encounter they activated. */
  readonly reading: (offer: OfferView, context: StepContext) => ReadingKind;
  /** An explicit Like or Save after reading. */
  readonly react?: (offer: OfferView, reading: ReadingKind, context: StepContext) => 'like' | 'save' | undefined;
  /** Recording is paused before this encounter and resumed before the other (the person's own Pause in settings). */
  readonly recording?: { readonly pauseBefore: number; readonly resumeBefore: number };
  /**
   * What the person does when the system has nothing to offer. By default they stop; a persona that sets this
   * taps "Somewhere new" instead (a fresh discovery), and stops only when that is empty too.
   */
  readonly stopsWhenEmpty?: boolean;
}

const pick = <T>(rng: Rng, weighted: readonly (readonly [T, number])[]): T => {
  const total = weighted.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = rng.next() * total;
  for (const [value, weight] of weighted) {
    roll -= weight;
    if (roll <= 0) return value;
  }
  return weighted[weighted.length - 1]![0];
};

/** A reading drawn from weights, for personas whose attention varies from stop to stop. */
export const mixOf = (rng: Rng, weights: Partial<Record<ReadingKind, number>>): ReadingKind =>
  pick(
    rng,
    (Object.entries(weights) as [ReadingKind, number][]).filter(([, weight]) => weight > 0),
  );
