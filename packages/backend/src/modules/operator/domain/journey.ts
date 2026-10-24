/**
 * Journey rules (pure): what a recorded step is called, which keys join steps, how a timeline is
 * ordered and where it has honest gaps. The data comes from the `ops.journey_events` view, one row
 * per recorded step of any module (D-044).
 */

/** One recorded step, as the view carries it. Keys are record IDs; `label` and `code` are code-shaped. */
export interface JourneyEvent {
  readonly stage: string;
  readonly startedAt: Date;
  readonly endedAt: Date | null;
  readonly state: string | null;
  readonly code: string | null;
  readonly label: string | null;
  readonly count: number | null;
  /** Set on a person's own records, null on shared records (groups, production, Reel orders). */
  readonly universeId: string | null;
  readonly requestId: string | null;
  readonly workId: string | null;
  readonly recipeKey: string | null;
  readonly productionRunId: string | null;
  readonly reasoningRunId: string | null;
  readonly attemptId: string | null;
  readonly exposureId: string | null;
  readonly offerId: string | null;
  readonly decisionId: string | null;
  readonly assetId: string | null;
  readonly reelOrderId: string | null;
  readonly commandId: string | null;
  /** The record's own ID, when it has one worth showing. */
  readonly subjectId: string | null;
}

/** The record keys a step can be joined by. Each names a column of the view. */
export const JOIN_KEYS = [
  'workId',
  'productionRunId',
  'reasoningRunId',
  'attemptId',
  'exposureId',
  'offerId',
  'decisionId',
  'assetId',
  'reelOrderId',
  'commandId',
] as const;

export type JoinKey = (typeof JOIN_KEYS)[number];

/** What the ID given to the inspector turned out to be. */
export type JourneySubject =
  'request' | 'production_run' | 'exposure' | 'reel_order' | 'attempt' | 'run' | 'asset' | 'universe';

/** IDs to search for, by key. `recipeKeys` find production runs a shared group commissioned. */
export type RelatedKeys = { readonly [key in JoinKey]: readonly string[] } & { readonly recipeKeys: readonly string[] };

/**
 * Where a given ID is looked for, in the order it is tried. An asset is shared by many people, so the
 * store answers an asset ID with shared steps only; a universe ID is a person's whole journey.
 */
const SUBJECT_COLUMNS: readonly (readonly [JourneySubject, (event: JourneyEvent) => string | null])[] = [
  ['request', (event) => event.requestId],
  ['production_run', (event) => event.productionRunId],
  ['exposure', (event) => event.exposureId],
  ['reel_order', (event) => event.reelOrderId],
  ['attempt', (event) => event.attemptId],
  ['run', (event) => event.reasoningRunId],
  ['asset', (event) => event.assetId],
  ['universe', (event) => event.universeId],
];

/** What the ID is, judged by which key of the events it matched. `undefined` when no event carries it. */
export function subjectOf(id: string, events: readonly JourneyEvent[]): JourneySubject | undefined {
  for (const [subject, keyOf] of SUBJECT_COLUMNS) if (events.some((event) => keyOf(event) === id)) return subject;
  return undefined;
}

/** The person-scope universes the events belong to: the only ones a journey may read further into. */
export function universesOf(events: readonly JourneyEvent[]): readonly string[] {
  return [...new Set(events.flatMap((event) => (event.universeId === null ? [] : [event.universeId])))];
}

/** A step's identity, so the same record found twice is shown once. */
export function eventIdentity(event: JourneyEvent): string {
  return [
    event.stage,
    event.subjectId ?? '',
    event.universeId ?? '',
    event.commandId ?? '',
    event.startedAt.toISOString(),
  ].join('|');
}

/**
 * The keys of `events` that have not been searched yet. The caller adds the result to `searched`
 * and searches again until nothing new turns up or its round limit is reached.
 */
export function unsearchedKeys(events: readonly JourneyEvent[], searched: RelatedKeys): RelatedKeys {
  const fresh = (values: readonly (string | null)[], seen: readonly string[]) => [
    ...new Set(values.filter((value): value is string => value !== null && !seen.includes(value))),
  ];
  const groupRecipes = events.filter((event) => event.stage === 'supply.group').map((event) => event.recipeKey);
  return {
    ...keysBy((key) =>
      fresh(
        events.map((event) => event[key]),
        searched[key],
      ),
    ),
    recipeKeys: fresh(groupRecipes, searched.recipeKeys),
  };
}

/** `searched` with `fresh` added. */
export function withKeys(searched: RelatedKeys, fresh: RelatedKeys): RelatedKeys {
  return {
    ...keysBy((key) => [...searched[key], ...fresh[key]]),
    recipeKeys: [...searched.recipeKeys, ...fresh.recipeKeys],
  };
}

function keysBy(valuesOf: (key: JoinKey) => readonly string[]): { readonly [key in JoinKey]: readonly string[] } {
  const keys: { -readonly [key in JoinKey]?: readonly string[] } = {};
  for (const key of JOIN_KEYS) keys[key] = valuesOf(key);
  return keys as { readonly [key in JoinKey]: readonly string[] };
}

export const NO_KEYS: RelatedKeys = {
  workId: [],
  productionRunId: [],
  reasoningRunId: [],
  attemptId: [],
  exposureId: [],
  offerId: [],
  decisionId: [],
  assetId: [],
  reelOrderId: [],
  commandId: [],
  recipeKeys: [],
};

/** True when no key is left to search. */
export function isEmptyKeys(keys: RelatedKeys): boolean {
  return keys.recipeKeys.length === 0 && JOIN_KEYS.every((key) => keys[key].length === 0);
}

/**
 * Keeps the production runs of a recipe that began after a shared group of that recipe was made.
 * The group commissions production when it is created, so an earlier run cannot be its own. Other
 * steps pass unchanged.
 */
export function withoutRunsBeforeTheirGroup(events: readonly JourneyEvent[]): readonly JourneyEvent[] {
  const groupStart = new Map<string, number>();
  for (const event of events) {
    if (event.stage !== 'supply.group' || event.recipeKey === null) continue;
    const known = groupStart.get(event.recipeKey);
    const at = event.startedAt.getTime();
    if (known === undefined || at < known) groupStart.set(event.recipeKey, at);
  }
  return events.filter((event) => {
    if (event.stage !== 'content.production_run' || event.recipeKey === null) return true;
    const start = groupStart.get(event.recipeKey);
    return start === undefined || event.startedAt.getTime() >= start;
  });
}

const STAGE_TITLES: Readonly<Record<string, string>> = {
  'supply.request': 'Request',
  'supply.group': 'Shared group',
  'content.production_run': 'Scroll production',
  'reasoning.production_run': 'Writer run',
  'reasoning.production_attempt': 'Model attempt (production)',
  'reasoning.refused_answer': 'Answer refused',
  'content.asset_admitted': 'Content admitted',
  'content.reel_order': 'Reel order',
  'content.reel_attempt': 'Reel attempt',
  'reasoning.run': 'Reasoning run',
  'reasoning.attempt': 'Model attempt',
  'experience.exposure_opened': 'Opened',
  'experience.exposure_activated': 'Activated',
  'experience.offer': 'Offered',
  'experience.offer_activated': 'Offer opened',
  'experience.action': 'Action',
  'composer.decision': 'Composer decision',
  'evidence.observations': 'Observations received',
  'evidence.encounter_evidence': 'Evidence qualified',
  'receipt.command': 'Command receipt',
  'geography.run': 'Cartographer run',
  'planner.run': 'Planner run',
};

/** A short name for a stage; an unknown stage keeps its own name, so nothing is hidden. */
export function titleOf(stage: string): string {
  return STAGE_TITLES[stage] ?? stage;
}

/** One line of a timeline. */
export interface JourneyStep {
  readonly at: Date;
  readonly endedAt: Date | null;
  readonly stage: string;
  readonly title: string;
  readonly state: string | null;
  readonly code: string | null;
  readonly label: string | null;
  readonly count: number | null;
  readonly ref: string | null;
  /** A person's own record, or a shared one. */
  readonly scope: 'personal' | 'shared';
}

/** Something the records do not say, shown as a gap rather than guessed. */
export interface JourneyGap {
  readonly stage: string;
  readonly ref: string | null;
  readonly note: string;
}

export interface Journey {
  readonly subject: JourneySubject;
  readonly subjectId: string;
  readonly steps: readonly JourneyStep[];
  readonly gaps: readonly JourneyGap[];
  /** More steps exist than the inspector reads at once. */
  readonly truncated: boolean;
}

/** States of a started step that has not recorded an end. */
const OPEN_STATES: Readonly<Record<string, readonly string[]>> = {
  'reasoning.production_attempt': ['reserved', 'dispatched'],
  'reasoning.attempt': ['reserved', 'dispatched'],
  'content.reel_attempt': ['reserved', 'dispatched'],
  'content.production_run': ['research', 'writer'],
  'reasoning.production_run': ['admitted'],
  'reasoning.run': ['admitted'],
};

/** An unfinished step older than this is reported as having no recorded completion. */
export const STALE_AFTER_MS = 30 * 60_000;

/** The honest gaps of a timeline: unfinished steps and outcomes that are unknown. */
export function gapsOf(steps: readonly JourneyStep[], now: Date): readonly JourneyGap[] {
  const gaps: JourneyGap[] = [];
  for (const step of steps) {
    if (step.state === 'unknown')
      gaps.push({
        stage: step.stage,
        ref: step.ref,
        note: 'Outcome unknown. It is reconciled or written off, never sent again.',
      });
    else if (
      step.endedAt === null &&
      OPEN_STATES[step.stage]?.includes(step.state ?? '') === true &&
      now.getTime() - step.at.getTime() > STALE_AFTER_MS
    )
      gaps.push({ stage: step.stage, ref: step.ref, note: 'Started, and no completion has been recorded.' });
  }
  return gaps;
}

/** The timeline of `events`: oldest first, each record once, with its gaps. */
export function buildJourney(
  subject: JourneySubject,
  subjectId: string,
  events: readonly JourneyEvent[],
  options: { readonly now: Date; readonly truncated: boolean },
): Journey {
  const seen = new Set<string>();
  const steps = events
    .filter((event) => {
      const identity = eventIdentity(event);
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    })
    .sort(
      (left, right) => left.startedAt.getTime() - right.startedAt.getTime() || left.stage.localeCompare(right.stage),
    )
    .map((event): JourneyStep => ({
      at: event.startedAt,
      endedAt: event.endedAt,
      stage: event.stage,
      title: titleOf(event.stage),
      state: event.state,
      code: event.code,
      label: event.label,
      count: event.count,
      ref: event.subjectId,
      scope: event.universeId === null ? 'shared' : 'personal',
    }));
  return { subject, subjectId, steps, gaps: gapsOf(steps, options.now), truncated: options.truncated };
}
