import {
  MAX_PROPOSAL_OPERATIONS,
  QUIET_AFTER_MS,
  activityFor,
  latestSupportAt,
  proofSupports,
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
  const sampled = new Set(facts.contextOnly);
  for (const place of facts.objects) {
    if (sampled.has(place.key)) continue;
    const state = activityFor(facts, place);
    if (!state || (place.activity.availability === 'available' && place.activity.state === state)) continue;
    changes.push({
      kind: 'set_activity',
      objectId: place.id,
      state,
      supportRefs: proofSupports(facts, place).map((support) => support.ref),
    });
  }
  return changes;
}

/** When a place was last supported and when it next needs a look, as stored on its row (D-416). */
export interface PlaceSchedule {
  readonly key: string;
  /** The newest support activation under the place, as seen when its topic was last evaluated; null when it has none. */
  readonly lastSupportAt: string | null;
  /**
   * The earliest the place's activity may need to change: the moment its newest support turns 30 days old while it is
   * active, now while its stored activity differs from what its support implies, and null when nothing can change it
   * but new reading (it is quiet, or it has no support). Derived scheduling state, never evidence.
   */
  readonly quietCheckAt: string | null;
}

/**
 * The schedule of every place in `facts.objects`, after the changes the facts describe. A place with no support keeps
 * what it has and is never due. Absent support is not proof the place was never supported: it is the same rule as
 * `activityChanges`, so the sweep and a run agree on what is due.
 */
export function placeSchedules(facts: FormationFacts): PlaceSchedule[] {
  const sampled = new Set(facts.contextOnly);
  return facts.objects
    .filter((place) => !sampled.has(place.key))
    .map((place) => {
      const latest = latestSupportAt(facts, place);
      if (latest === undefined) return { key: place.key, lastSupportAt: null, quietCheckAt: null };
      const implied = activityFor(facts, place)!;
      const pending = place.activity.availability !== 'available' || place.activity.state !== implied;
      // `activityFor` is quiet only once the newest support is strictly more than the window old.
      const at = pending
        ? Date.parse(facts.evaluatedAt)
        : implied === 'active'
          ? latest + QUIET_AFTER_MS + 1
          : undefined;
      return {
        key: place.key,
        lastSupportAt: new Date(latest).toISOString(),
        quietCheckAt: at === undefined ? null : new Date(at).toISOString(),
      };
    });
}

/** How the quiet sweep paces itself (D-104, D-416). */
export const QUIET_SWEEP = {
  /**
   * Due places one pass looks at, oldest first, whether or not their universe can be settled. Each leaves the head of
   * the index in the same pass (leased or parked), so the head is always settleable.
   */
  batch: 100,
  /** Places one settle names, so its activity changes fit one delta. */
  placesPerSettle: MAX_PROPOSAL_OPERATIONS,
  /** How long a handed-over place is left alone while its settle is queued or running. */
  leaseMs: 30 * 60_000,
  /**
   * How long a due place that cannot be settled now (recording paused, a run holds its universe, a Clear in
   * progress, support unreadable) is left alone before the sweep looks at it again.
   */
  parkMs: 24 * 3_600_000,
} as const;
