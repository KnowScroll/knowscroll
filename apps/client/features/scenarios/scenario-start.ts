import type { ScenarioAsk } from '@knowscroll/client-core';
import type { Assumption, ScenarioKind } from '@knowscroll/contracts';
import type { MessageQuote } from './message-step';

/** Where a new request starts: its kind, where in the thread it came from and what it continues. */
export interface RequestStart {
  /** Absent when the request started from a message's menu: the member picks the kind first (`quote`). */
  readonly kind?: ScenarioKind;
  /** What the message says, shown above the choice of kind. */
  readonly quote?: MessageQuote;
  readonly origin: ScenarioAsk['origin'];
  /** "the whole thread", "Ravi’s message", "a moment someone shared": the source in words (X01 "From:"). */
  readonly fromLabel: string;
  readonly parent: ScenarioAsk['parent'];
  /** What already holds where this continues: the premises of the branch it continues, none at the root. */
  readonly premises: readonly Assumption[];
  /** The member's idea already written (the prompt at the end of a branch): the sheet asks for directions at once. */
  readonly words?: string;
}

/** A direction the Planner already offered and the member has not made: the sheet picks its draft up and shows its options. */
export interface OfferStart {
  readonly offer: { readonly draftId: string; readonly kind: ScenarioKind };
  /** What holds where the offer would continue: the premises the own-request form lists. */
  readonly premises: readonly Assumption[];
}

export type ScenarioStart = RequestStart | OfferStart;

/** A request whose kind is known: the member picked it, or the entry point named it. */
export type KindedStart = RequestStart & { readonly kind: ScenarioKind };
