import type { ScenarioAsk } from '@knowscroll/client-core';
import type { Assumption, ScenarioKind } from '@knowscroll/contracts';
import type { MessageQuote } from './message-step';

/** Where a request starts: its kind, where in the thread it came from and what it continues. */
export interface ScenarioStart {
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
}

/** A start whose kind is known: the member picked it, or the entry point named it. */
export type KindedStart = ScenarioStart & { readonly kind: ScenarioKind };
