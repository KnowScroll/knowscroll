import {
  NO_KEYS,
  buildJourney,
  eventIdentity,
  isEmptyKeys,
  subjectOf,
  unsearchedKeys,
  universesOf,
  withKeys,
  withoutRunsBeforeTheirGroup,
  type Journey,
  type JourneyEvent,
} from '../domain/journey.js';
import type { JourneyStore } from './ports.js';

/** The most steps one journey shows. Beyond it the newest are kept and `truncated` is set. */
export const MAX_JOURNEY_STEPS = 300;

/** How many times the inspector follows keys from what it found to what they join. */
const MAX_ROUNDS = 4;

export type JourneyOutcome = { readonly kind: 'found'; readonly journey: Journey } | { readonly kind: 'not_found' };

/**
 * Use case: the journey of one record, as a timeline across modules.
 *
 * Input: an ID of a request, production run, Reel order, model attempt, reasoning run, exposure or
 * asset, and with `allowPerson` a universe. Output: its steps oldest first, with the gaps the records leave, or `not_found`.
 * Authority: the caller has already decided that the person may inspect (the operator check at the
 * API, the operator shell for the CLI). Reads only the `ops` allowlist; it never reads another
 * person's records: once the first step names a universe, later rounds read that universe's
 * records and shared records only.
 * Side effects: none. Failure: a store error is thrown; there is nothing to retry or roll back.
 */
export type ReadJourney = (id: string, options?: JourneyOptions) => Promise<JourneyOutcome>;

export interface JourneyOptions {
  /**
   * Allow a universe ID, which opens a person's whole journey. Only the operator command sets it:
   * finding a person is a separate step from reading a record (blueprint §26). Off by default, so the
   * API never answers it.
   */
  readonly allowPerson?: boolean;
}

function merged(known: readonly JourneyEvent[], found: readonly JourneyEvent[]): JourneyEvent[] {
  const identities = new Set(known.map(eventIdentity));
  return [...known, ...found.filter((event) => !identities.has(eventIdentity(event)))];
}

export function makeReadJourney(deps: { readonly store: JourneyStore; readonly now: () => Date }): ReadJourney {
  return async (id, options = {}) => {
    const seed = await deps.store.findById(id, MAX_JOURNEY_STEPS + 1, options.allowPerson === true);
    if (seed.length === 0) return { kind: 'not_found' };
    const universes = universesOf(seed);
    let events: JourneyEvent[] = [...seed];
    let searched = NO_KEYS;
    for (let round = 0; round < MAX_ROUNDS && events.length <= MAX_JOURNEY_STEPS; round += 1) {
      const fresh = unsearchedKeys(events, searched);
      if (isEmptyKeys(fresh)) break;
      searched = withKeys(searched, fresh);
      const related = await deps.store.findRelated(fresh, universes, MAX_JOURNEY_STEPS + 1);
      events = merged(events, related);
    }
    events = [...withoutRunsBeforeTheirGroup(events)].sort(
      (left, right) => right.startedAt.getTime() - left.startedAt.getTime(),
    );
    const truncated = events.length > MAX_JOURNEY_STEPS;
    const subject = subjectOf(id, seed) ?? 'universe';
    return {
      kind: 'found',
      journey: buildJourney(subject, id, events.slice(0, MAX_JOURNEY_STEPS), { now: deps.now(), truncated }),
    };
  };
}
