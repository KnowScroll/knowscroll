import type { ReadingKind } from './reading.js';

export type Format = 'reel' | 'scroll';

/** One offer the system chose, resolved to the fixture library. */
export interface OfferView {
  readonly offerId: string;
  readonly assetId: string;
  readonly assetRevision: number;
  readonly unitId: string;
  readonly kind: Format;
  readonly topicId: string;
  readonly systemId: string;
  /** True when the person had already met this explanation (in either format) when it was offered. */
  readonly alreadyMet: boolean;
}

/** `open` is a link the person follows (a shared link or a saved item): a move they asked for, not one the system chose. */
export type MoveKind = 'discover' | 'vertical' | 'region' | 'open';
// `region` is also recorded for a move made inside a region the person opened: the Composer offers what the region holds.

/** One navigation the person made and what the system answered. */
export interface MoveRecord {
  readonly index: number;
  readonly move: MoveKind;
  /** The format the person named (a vertical move keeps the format the person is in). */
  readonly asked?: Format;
  readonly status: 'ready' | 'pending' | 'exhausted' | 'refused';
  readonly reason?: string;
  readonly decisionId?: string;
  /** The offer the person was shown first, then the buffered ones. */
  readonly offers: readonly OfferView[];
  /** The explanations the person had met when this move was made. */
  readonly metBefore: readonly string[];
  /** Explanations of the library the person had not met when this move was made. */
  readonly unseenBefore: number;
  /** Unseen explanations that no slot of this answer offered. */
  readonly unseenLeftOut: number;
  readonly millis: number;
}

export interface EncounterRecord {
  readonly index: number;
  readonly exposureId: string;
  readonly offer: OfferView;
  readonly move: MoveKind;
  readonly reading: ReadingKind;
  /** What the evidence rules should conclude for this reading. */
  readonly expectQualified: boolean;
  /** Whether recording was on, so the encounter belongs to the person's history. */
  readonly recorded: boolean;
  readonly events: number;
  /** The projection's own answer, read back after the drain. */
  qualification?: 'qualified' | 'not_qualified' | 'unknown';
}

/** What the lab saw of Geography after one drain, to date the first system and planet and check I2. */
export interface FormationPoint {
  readonly encounter: number;
  readonly systems: number;
  readonly planets: number;
  readonly regions: number;
  /** Distinct trusted coverage supports Personal Context held after the drain. */
  readonly trustedSupports: number;
  /** Raw coverage references Personal Context held after the drain (one per qualified reading of a mapped facet). */
  readonly references: number;
  /** Geography runs that settled `insufficient`, by outcome, in total, after the drain. */
  readonly insufficientOutcomes: Readonly<Record<string, number>>;
}
