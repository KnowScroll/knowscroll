import { dueCreations } from './formation.js';
import { MAX_PROPOSAL_OPERATIONS, type FormationFacts } from './policy.js';
import { activityChanges } from './quiet.js';

/**
 * What one Cartographer run would do for one universe if it ran now (D-411).
 *
 * - `not_runnable`: the universe or its account is not active, or a Clear runs. No run would record anything.
 * - `recording_paused`: recording is paused, so a run is retired and records nothing new.
 * - `would_fail`: building the context throws a coded fault, so the job would fail and retry.
 * - `stops`: the run settles with no model call and applies nothing: the role is off, no context can be
 *   frozen, or nothing is due.
 * - `applies_rules`: the rules apply what is due with no model call: only activity changes, or a context too
 *   large for one model request.
 * - `calls_model`: places are due and the context fits one request, so the run asks the model. Code then applies
 *   everything due.
 */
export type GeographyDryRunAction = 'not_runnable' | 'recording_paused' | 'would_fail' | 'stops' | 'applies_rules' | 'calls_model';

/**
 * What the run's row would hold afterwards. `outcome` is exactly the code a real run records
 * (`geography.runs.outcome`): `no_changes`, `disabled`, `no_support_yet`, `no_trusted_support`, `discovery_limit`,
 * `coverage_limit`, `coverage_authority_changed`, `structure_limit`, `context_too_large`, `applied_by_rules`,
 * `applied_by_rules_context_limit`. It is null when the model's answer decides it (`applied`, `applied_with_rules`
 * or `applied_by_rules`).
 */
export interface GeographyWouldRecord {
  readonly status: 'insufficient' | 'accepted';
  readonly outcome: string | null;
}

/** What preparing a context found, as counts, when one could be frozen. */
export interface GeographyPreparedFacts {
  /** The facts the rules read. They carry labels and ids; the report never shows them. */
  readonly formation: FormationFacts;
  /** Distinct (topic, facet, unit) keys discovery found. */
  readonly candidateKeys: number;
  /** Witnesses (exposure-level references) the frozen context holds. */
  readonly witnessesHeld: number;
  /** Distinct supports the catalogue and truth checks accept, before compaction. */
  readonly supportKeys: number;
  readonly contextBytes: number;
  /** How many items one model request would hold, or `too_large` when the context does not fit one. */
  readonly modelItems: number | 'too_large';
}

/** The facts the report is made from. */
export interface GeographyDryRunFacts {
  readonly gate: 'open' | 'not_runnable' | 'recording_paused';
  readonly roleEnabled: boolean;
  /** The places and the routes and aliases stored, when the gate is open. */
  readonly places: number | undefined;
  readonly routes: number | undefined;
  /** Why no context was prepared, as the code a run records (`no_support_yet`, `discovery_limit`, ...). */
  readonly refusal: string | undefined;
  readonly prepared: GeographyPreparedFacts | undefined;
  /** A coded fault building the context threw, such as `GEOGRAPHY_WITNESS_AUTHORITY`. */
  readonly failureCode: string | undefined;
}

export interface GeographyDryRunReport {
  readonly trigger: 'reading';
  readonly action: GeographyDryRunAction;
  readonly wouldRecord: GeographyWouldRecord | null;
  readonly wouldCallModel: boolean;
  readonly roleEnabled: boolean;
  readonly failureCode: string | null;
  readonly places: number | null;
  readonly routes: number | null;
  readonly references: {
    /** Distinct (topic, facet, unit) keys discovery found. */
    readonly candidateKeys: number | null;
    /** Witnesses the frozen context holds (after compaction). */
    readonly witnessesHeld: number | null;
    /** Distinct supports accepted before compaction. */
    readonly supportKeys: number | null;
    readonly supportsKept: number | null;
    readonly supportsDropped: number | null;
  };
  readonly due: {
    readonly system: number;
    readonly star: number;
    readonly planet: number;
    readonly region: number;
    readonly total: number;
    /** What one delta applies: at most 32 operations, creations first. */
    readonly appliedByNextRun: number;
  };
  readonly activityChanges: { readonly toQuiet: number; readonly toActive: number };
  readonly contextBytes: number | null;
  readonly modelItems: number | null;
}

const DUE_KIND = {
  create_system: 'system',
  establish_star: 'star',
  form_planet: 'planet',
  add_region: 'region',
} as const;

const stops = (outcome: string): Pick<GeographyDryRunReport, 'action' | 'wouldRecord'> => ({
  action: 'stops',
  wouldRecord: { status: 'insufficient', outcome },
});

/** The order `makeRunCartographer` decides in: the gate, the switch, a fault, no context, due places, activity, nothing. */
function decide(
  facts: GeographyDryRunFacts,
  dueTotal: number,
  activityTotal: number,
): Pick<GeographyDryRunReport, 'action' | 'wouldRecord'> {
  if (facts.gate !== 'open') return { action: facts.gate, wouldRecord: null };
  if (!facts.roleEnabled) return stops('disabled');
  if (facts.failureCode !== undefined) return { action: 'would_fail', wouldRecord: null };
  if (facts.refusal !== undefined) return stops(facts.refusal);
  const modelItems = facts.prepared?.modelItems;
  if (dueTotal > 0 && modelItems === 'too_large')
    return { action: 'applies_rules', wouldRecord: { status: 'accepted', outcome: 'applied_by_rules_context_limit' } };
  if (dueTotal > 0) return { action: 'calls_model', wouldRecord: { status: 'accepted', outcome: null } };
  if (activityTotal > 0)
    return { action: 'applies_rules', wouldRecord: { status: 'accepted', outcome: 'applied_by_rules' } };
  return stops('no_changes');
}

/**
 * Shapes the dry run's facts into the report an operator may paste into a public issue: counts and codes, never a
 * label, title, topic, unit or support reference. Pure. `wouldRecord.outcome` is the code a real run records.
 */
export function shapeGeographyDryRun(facts: GeographyDryRunFacts): GeographyDryRunReport {
  const { prepared } = facts;
  const due = prepared === undefined ? [] : dueCreations(prepared.formation);
  const changes = prepared === undefined ? [] : activityChanges(prepared.formation);
  const byKind = { system: 0, star: 0, planet: 0, region: 0 };
  for (const operation of due) byKind[DUE_KIND[operation.kind]] += 1;
  const decided = decide(facts, due.length, changes.length);
  const supportsKept = prepared?.formation.supports.length ?? null;
  const supportKeys = prepared?.supportKeys ?? null;
  return {
    trigger: 'reading',
    ...decided,
    wouldCallModel: decided.action === 'calls_model',
    roleEnabled: facts.roleEnabled,
    failureCode: facts.failureCode ?? null,
    places: facts.places ?? null,
    routes: facts.routes ?? null,
    references: {
      candidateKeys: prepared?.candidateKeys ?? null,
      witnessesHeld: prepared?.witnessesHeld ?? null,
      supportKeys,
      supportsKept,
      supportsDropped: supportKeys === null || supportsKept === null ? null : supportKeys - supportsKept,
    },
    due: {
      ...byKind,
      total: due.length,
      appliedByNextRun: Math.min(due.length + changes.length, MAX_PROPOSAL_OPERATIONS),
    },
    activityChanges: {
      toQuiet: changes.filter((change) => change.state === 'quiet').length,
      toActive: changes.filter((change) => change.state === 'active').length,
    },
    contextBytes: prepared?.contextBytes ?? null,
    modelItems: typeof prepared?.modelItems === 'number' ? prepared.modelItems : null,
  };
}
