import {
  QUIET_AFTER_MS,
  activityFor,
  latestSupportAt,
  supportsFor,
  type FormationFacts,
  type GeographyProposal,
} from './policy.js';

/** A change of one place between active and quiet. */
export type ActivityChange = Extract<GeographyProposal['operations'][number], { kind: 'set_activity' }>;

/**
 * Established places whose stored activity differs from what their latest verified support implies
 * (D-038): quiet when the newest support is more than 30 days old, active otherwise. A place with no
 * support keeps what it has. Inactivity changes a place's activity and never its existence, id,
 * label or origin. Pure: the Cartographer's run and the quiet sweep both apply exactly this rule.
 */
export function activityChanges(facts: FormationFacts): ActivityChange[] {
  const changes: ActivityChange[] = [];
  for (const place of facts.objects) {
    const state = activityFor(facts, place);
    if (!state || (place.activity.availability === 'available' && place.activity.state === state)) continue;
    changes.push({
      kind: 'set_activity',
      objectId: place.id,
      state,
      supportRefs: supportsFor(facts, place).map((support) => support.ref),
    });
  }
  return changes;
}

/**
 * The earliest time any place's activity may need to change, given the places in `facts.objects`:
 * the moment the newest support under an active place turns 30 days old, or now when a change is
 * already due. Absent when no place can go quiet. Derived scheduling state, never evidence; callers
 * store it so a sweep finds due universes without reading anyone's support.
 *
 * It is a lower bound: later reading only moves the true time forward, and a sweep that finds
 * nothing due stores the corrected value.
 */
export function nextQuietAt(facts: FormationFacts): string | undefined {
  let earliest: number | undefined;
  for (const place of facts.objects) {
    const implied = activityFor(facts, place);
    if (!implied) continue;
    const pending = place.activity.availability !== 'available' || place.activity.state !== implied;
    // `activityFor` is quiet only once the newest support is strictly more than the window old.
    const at = pending ? Date.parse(facts.evaluatedAt) : implied === 'active' ? quietFrom(facts, place) : undefined;
    if (at !== undefined && (earliest === undefined || at < earliest)) earliest = at;
  }
  return earliest === undefined ? undefined : new Date(earliest).toISOString();
}

function quietFrom(facts: FormationFacts, place: FormationFacts['objects'][number]): number | undefined {
  const latest = latestSupportAt(facts, place);
  return latest === undefined ? undefined : latest + QUIET_AFTER_MS + 1;
}

/** How the quiet sweep paces itself (D-104). */
export const QUIET_SWEEP = {
  /** Universes one pass hands to a settle. The rest wait for the next pass. */
  batch: 100,
  /** How long a handed-over universe is left alone while its settle is queued or running. */
  leaseMs: 30 * 60_000,
  /** How long to wait before settling a universe whose support could not be read. */
  unreadableRetryMs: 24 * 3_600_000,
} as const;

/** `state` with its `nextQuietAt` set to `at`, or without one when `at` is absent. */
export function withNextQuietAt<State extends { readonly nextQuietAt?: string }>(
  state: State,
  at: string | undefined,
): State {
  const { nextQuietAt: _previous, ...rest } = state;
  return (at === undefined ? rest : { ...rest, nextQuietAt: at }) as State;
}
