import { callsOf } from '@knowscroll/scroll-model';
import type { EncounterEntry } from './encounter-history';
import type { StageEntry } from './encounter-stage';

/** What the "Next topic" card says: where the person has landed and what they left. */
export interface FormatNote {
  /** "NEXT TOPIC · AS A SCROLL": the format stays the one the person was in (D-132). */
  readonly kicker: string;
  readonly title: string;
  /** "Football · 4 min · 2 calls": only what the document itself says. */
  readonly facts: string;
  /** The Scroll just left, kept as it was: its title, and the stop it was on when there is one. */
  readonly kept: { readonly title: string; readonly at: number | undefined; readonly of: number | undefined };
  /** The Reel of this same topic is ready, so "Switch to Reel" is a move that works. */
  readonly canSwitchToReel: boolean;
}

/** The words the card says about the Scroll just left: "Seasons Part 1 is kept at 4 of 10." */
export function keptWords(kept: FormatNote['kept']): string {
  return kept.at === undefined || kept.of === undefined
    ? `${kept.title} is kept.`
    : `${kept.title} is kept at ${String(kept.at)} of ${String(kept.of)}.`;
}

/**
 * The card shown after Next ↑, a pull past the end or N lands on another Scroll (V3 G4): "Next topic · as a Scroll", with a way
 * to switch to the Reel of the same topic and an Undo. It amends D-132 only in saying so: the format still stays. It is shown
 * for a Scroll that was reached from a Scroll by a new topic (a discovery after an entry in the trail), never for the first
 * open, a Part, a related move, a format switch or a Back. Everything on it is read from the two entries.
 */
export function formatNoteOf(trail: readonly EncounterEntry[], entry: StageEntry): FormatNote | undefined {
  const before = trail.at(-2);
  if (trail.at(-1) !== entry || entry.offer.relation.kind !== 'discovery') return undefined;
  if (before?.kind !== 'scroll') return undefined;
  const { document } = entry.scroll;
  const minutes = Math.max(1, Math.round(document.measures.readingMinutes));
  const calls = callsOf(document).length;
  const facts = [
    document.kicker,
    `${String(minutes)} min`,
    calls === 0 ? undefined : calls === 1 ? '1 call' : `${String(calls)} calls`,
  ]
    .filter((part): part is string => part !== undefined && part !== '')
    .join(' · ');
  const left = before.scroll;
  const stops = 'stops' in left.document ? left.document.stops : undefined;
  const placeId = before.position?.kind === 'scroll' ? before.position.value.blockId : undefined;
  const at =
    stops === undefined || placeId === undefined ? undefined : stops.findIndex((stop) => stop.id === placeId) + 1;
  return {
    kicker: 'NEXT TOPIC · AS A SCROLL',
    title: document.title,
    facts,
    kept: {
      title: left.document.title,
      at: at === undefined || at < 1 ? undefined : at,
      of: stops === undefined || at === undefined || at < 1 ? undefined : stops.length,
    },
    canSwitchToReel: entry.context.variants.some((variant) => variant.kind === 'reel' && variant.status === 'ready'),
  };
}
