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
    const proof = proofSupports(facts, place);
    // A change with nothing to cite is not a change the rules can prove: the place keeps what it has.
    if (!proof.length) continue;
    changes.push({ kind: 'set_activity', objectId: place.id, state, supportRefs: proof.map((support) => support.ref) });
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

/**
 * How the quiet sweep paces itself (D-104, D-416).
 *
 * Capacity: the sweep runs every 15 minutes (96 passes a day) and a pass takes up to `pagesPerPass` pages of `batch` places,
 * 50,000 places a pass and 4,800,000 a day. At the scale the operator's cost tests use (50,000 universes) a universe holds
 * about a hundred places that are not quiet, so a migration-day backlog in which every such place is due once (about
 * 5,000,000 at the very most; 4,800,000 at an average of 96) drains in a day, and a development database (tens of universes,
 * under a hundred thousand places even at the 1000-place bound) drains in its first pass or two. A pass is bounded by pages
 * as well as places: a page is one indexed query and at most 16 settle jobs, about 150 ms, so a full pass takes about 15
 * seconds against the queue's 120. The settles it hands over (1,563 for a full pass) are what the workers drain between
 * passes; a place whose settle has not run when its lease ends is handed over again, which is safe.
 */
export const QUIET_SWEEP = {
  /** Due places one page looks at, oldest first, whether or not their universe can be settled. Each leaves the head of the index in the same page (leased or parked), so the head is always settleable. */
  batch: 500,
  /** Pages one pass takes before it stops, so a pass has a bounded cost however large the backlog. */
  pagesPerPass: 100,
  /** Places one settle names, so its activity changes fit one delta. */
  placesPerSettle: MAX_PROPOSAL_OPERATIONS,
  /** How long a handed-over place is left alone while its settle is queued or running. */
  leaseMs: 30 * 60_000,
  /**
   * How long a due place whose universe will not be settled for a while (recording paused, a Clear in progress, the account
   * suspended) is left alone before the sweep looks at it again.
   */
  parkMs: 24 * 3_600_000,
  /**
   * How long a due place whose universe is held by a Cartographer run is left alone: the run settles within minutes, so the
   * place is tried again by the next pass, not tomorrow.
   */
  runHeldMs: 5 * 60_000,
  /**
   * A place a settle could not read (its topic has no support, or its support could not be read) is looked at again after
   * `unreadBaseMs`, doubling each time up to `parkMs`, and not at all after `unreadAttempts` looks: nothing changes it but
   * new reading, which stores its schedule again. Without a bound a place with no support would be looked at daily for ever.
   */
  unreadBaseMs: 3_600_000,
  unreadAttempts: 6,
} as const;

/**
 * When a place whose settle could not read it is looked at next, in ms from now, after `looks` such looks (this one included,
 * so at least 1): an hour, then doubling up to a day, and none (absent) from the `unreadAttempts`th look on.
 */
export function unreadRetryMs(looks: number): number | undefined {
  return looks >= QUIET_SWEEP.unreadAttempts
    ? undefined
    : Math.min(QUIET_SWEEP.unreadBaseMs * 2 ** (looks - 1), QUIET_SWEEP.parkMs);
}
