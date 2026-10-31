import type { ProductionScopeTx } from '../../../reasoning/public.js';
import type { RitualKind, RitualState } from '../domain/rituals.js';

/**
 * What the ritual batch and the operator's review need from storage (D-176). A room's daily items are not personal, so
 * none of this runs under a personal root: the flaw is stored inside the room reasoning scope's own transaction (as a
 * kit is), and every other method is a short read or write of room rows. No method reads a message or a person.
 */

/** A room as the batch sees it: enough to find its library topic. */
export interface RitualRoom {
  readonly roomId: string;
  readonly slug: string;
  readonly topic: { readonly kind: 'system' | 'planet'; readonly id: string };
}

/** One stored item, as an operator reads it. `payload` is as stored; the use case parses it before trusting it. */
export interface RitualRow {
  readonly ritualId: string;
  readonly room: RitualRoom;
  readonly day: string;
  readonly kind: RitualKind;
  readonly state: RitualState;
  readonly payload: unknown;
  readonly payloadVersion: string;
  readonly madeBy: 'template' | 'model';
  readonly createdAt: Date;
  readonly decidedBy: string | null;
}

export interface NewRitual {
  readonly ritualId: string;
  readonly roomId: string;
  readonly day: string;
  readonly kind: RitualKind;
  readonly payload: object;
  readonly madeBy: 'template' | 'model';
  readonly roleVersion: string | undefined;
  readonly model: string | undefined;
  readonly attemptId: string | undefined;
  readonly at: Date;
}

export type RitualDecision = 'approved' | 'rejected';
export type RitualDecisionOutcome = 'decided' | 'unknown' | 'not_draft';

export interface RitualStore {
  /** Open rooms with at least one current member, by slug: the rooms a night's batch drafts for. */
  roomsWithMembers(): Promise<readonly RitualRoom[]>;
  roomBySlug(slug: string): Promise<RitualRoom | undefined>;
  /** Which items the room already has for the day, in any state (a rejected item is not made again). */
  kindsOn(roomId: string, day: string): Promise<ReadonlySet<RitualKind>>;
  /** The Scrolls the room's items cited on the `days` days before `day`, in any state but rejected. */
  recentSources(roomId: string, day: string, days: number): Promise<ReadonlySet<string>>;
  /** The calls the room's Launch decks asked on the `days` days before `day`, in any state but rejected, as `assetId:stopId`. */
  recentCalls(roomId: string, day: string, days: number): Promise<ReadonlySet<string>>;
  /** Stores a draft; false when the room already has an item of that kind for the day (the unique key is the cap). */
  insertDraft(item: NewRitual): Promise<boolean>;
  /** The same, inside the room scope's transaction, so the item and the end of its model run commit together. */
  insertDraftIn(scope: ProductionScopeTx, item: NewRitual): Promise<boolean>;
  list(filter: { readonly state: RitualState | undefined }, limit: number): Promise<readonly RitualRow[]>;
  one(ritualId: string): Promise<RitualRow | undefined>;
  decide(input: {
    readonly ritualId: string;
    readonly decision: RitualDecision;
    readonly by: string;
    readonly at: Date;
  }): Promise<RitualDecisionOutcome>;
}
