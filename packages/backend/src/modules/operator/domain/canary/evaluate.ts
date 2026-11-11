import type { PersonaId } from './personas.js';

/**
 * What a canary run saw, and the invariants that judge it (#674, D-413). The driver records facts from public
 * routes and read-only operator reads; this file decides which of them break a product rule. Every check fires on
 * its own condition and is tested alone. Nothing here names a person, an asset, a title or a link: only counts
 * and codes leave the evaluator. Pure: no clock, no I/O.
 */

export type OfferFormat = 'scroll' | 'reel';
export type OfferRelation = 'discovery' | 'series_step' | 'related_move' | 'format_variant' | 'return';
/** `discover` is the first open; the others are the moves a reader makes from an encounter. */
export type MoveMode = 'discover' | 'vertical' | 'series' | 'variant' | 'region';

export interface OfferRecord {
  /** The explanation unit: a Scroll and its Reel twin share it. Opaque; never printed. */
  readonly unitId: string;
  readonly format: OfferFormat;
  readonly relation: OfferRelation;
  readonly seriesId: string | undefined;
  /** The reader had already opened this unit (either format) before this move. */
  readonly alreadyMet: boolean;
  /** The offer says a Reel of the same explanation is ready. */
  readonly readyReelVariant: boolean;
  /** When the system made the offer, on the run's one clock (ms): a witness counts only from then on. */
  readonly at: number;
}

export interface MoveRecord {
  readonly mode: MoveMode;
  /** When the system answered, on the run's one clock (ms). */
  readonly at: number;
  readonly outcome: 'ready' | 'pending' | 'exhausted';
  /** The chosen offer first, then the prepared ones. Empty unless ready. */
  readonly offers: readonly OfferRecord[];
  /** The units the reader had met when it asked. */
  readonly metBefore: readonly string[];
  /** The series of the encounter it moved from, when that is known: a subject move leaves it. */
  readonly sourceSeriesId: string | undefined;
  /** How often a `pending` answer was asked again. */
  readonly retries: number;
}

/**
 * `not_projected`: the worker had nothing pending and still committed no evidence. `inconclusive`: evidence was
 * still being projected when the wait ran out, so what it will say is not known: not red, and not green either.
 */
export type EvidenceState =
  'qualified' | 'not_qualified' | 'unknown' | 'not_projected' | 'inconclusive' | 'not_applicable';

export interface EncounterRecord {
  readonly unitId: string;
  readonly format: OfferFormat;
  /** `read` is a reading or watching that should qualify; `glance` opens and moves on. */
  readonly attendance: 'read' | 'glance';
  readonly seriesId: string | undefined;
  readonly accepted: number;
  readonly duplicates: number;
  readonly rejected: number;
  /** The intake answered `not_recorded`: the recording policy was not the one the reader sent. */
  readonly notRecorded: boolean;
  readonly evidence: EvidenceState;
}

export interface FormationReading {
  readonly dust: number;
  readonly systems: number;
  readonly planets: number;
  readonly regions: number;
}

export interface PersonaRecord {
  readonly persona: PersonaId;
  readonly moves: readonly MoveRecord[];
  readonly encounters: readonly EncounterRecord[];
  /** Answers the route's own contract does not allow here (a status and stable code, never a body). */
  readonly problems: readonly { readonly route: string; readonly status: number; readonly code: string }[];
  readonly formation: FormationReading | undefined;
  readonly media: { readonly checked: number; readonly failed: number };
  readonly regionSwitch: 'opened' | 'none_available' | 'not_attempted';
}

/** A Planner or Cartographer run as the operator view shows it. `ended` is set only by a settled state. */
export interface RunRow {
  readonly state: string;
  readonly ended: boolean;
  readonly ageSeconds: number;
}

export interface JobRow {
  readonly queue: string;
  readonly state: string;
  readonly count: number;
}

export interface OperatorReads {
  readonly planner: readonly RunRow[];
  readonly geography: readonly RunRow[];
  readonly jobs: readonly JobRow[];
  /** Composer decisions by policy label. */
  readonly policies: readonly { readonly label: string; readonly count: number }[];
  /** Supply requests of the run's universes, and the shared work they started or joined (D-413: always 0). */
  readonly supply: { readonly requests: number; readonly commissionedWork: number };
  /** Model attempts whose request left, by the purpose of the run they belong to: what the canary spent. */
  readonly attempts: readonly { readonly role: string; readonly count: number }[];
}

export interface CanaryRun {
  readonly personas: readonly PersonaRecord[];
  /** `undefined` when the reads failed: that is itself a violation. */
  readonly reads: OperatorReads | undefined;
  readonly cleanup: { readonly kept: boolean; readonly requested: number; readonly completed: number };
}

export const VIOLATION_CODES = [
  'first_offer_missing',
  'repeat_while_unseen_exists',
  'exhausted_while_unseen_exists',
  'reel_never_offered',
  'reading_not_stored',
  'reading_not_projected',
  'reading_not_qualified',
  'formation_system_missing',
  'formation_planet_missing',
  'reel_media_unreachable',
  'api_refused',
  'operator_reads_failed',
  'job_failed',
  'job_dead_lettered',
  'shared_supply_touched',
  'planner_run_unknown',
  'planner_run_stuck',
  'geography_run_stuck',
  'cleanup_incomplete',
] as const;
export type ViolationCode = (typeof VIOLATION_CODES)[number];

export interface Violation {
  readonly code: ViolationCode;
  readonly persona?: PersonaId;
  readonly count: number;
}

/** A queued run older than this has not been merely paced (the Planner waits five minutes, then a model call). */
export const RUN_STUCK_AFTER_SECONDS = 15 * 60;
/** Distinct qualified units of one series after which the rules entitle a system, and then a planet. */
export const SERIES_UNITS_FOR_SYSTEM = 2;
export const SERIES_UNITS_FOR_PLANET = 3;

const DEAD_LETTER_SUFFIX = '.dead';

/**
 * Whether a Planner or Cartographer run is still on its way: not settled, and not parked (`blocked` waits for the
 * world to allow it, `unknown` for an operator). The canary waits for these, within its bound, before judging.
 */
export function runsPending(reads: OperatorReads): boolean {
  return [...reads.planner, ...reads.geography].some(
    (row) => !row.ended && row.state !== 'blocked' && row.state !== 'unknown',
  );
}

/** Offers a reader asked the system to choose (a first open or a subject move) are the ones the no-re-read rule binds. */
function systemChosen(move: MoveRecord): boolean {
  return move.mode === 'discover' || move.mode === 'vertical';
}

/**
 * Units some canary reader was offered by discovery, at or before this move, that this reader had not met. They existed
 * in the library and were eligible for someone, which is the only public proof there is that "unseen exists". A unit of
 * the series the reader moved from is left out, because a subject move leaves its own series (D-408).
 */
function unseenWitnesses(run: CanaryRun, move: MoveRecord, repeated: ReadonlySet<string>): number {
  const met = new Set(move.metBefore);
  const sourceSeries = move.sourceSeriesId;
  const witnessed = new Set<string>();
  for (const persona of run.personas)
    for (const other of persona.moves)
      for (const offer of other.offers) {
        if (offer.relation !== 'discovery') continue;
        // A unit first offered after this move may not have existed yet (a Scroll released mid-run): not a witness.
        if (offer.at > move.at) continue;
        if (met.has(offer.unitId) || repeated.has(offer.unitId)) continue;
        if (sourceSeries !== undefined && offer.seriesId === sourceSeries) continue;
        witnessed.add(offer.unitId);
      }
  return witnessed.size;
}

function noRereads(run: CanaryRun): { violations: Violation[]; lastResort: Map<PersonaId, number> } {
  const violations: Violation[] = [];
  const lastResort = new Map<PersonaId, number>();
  for (const persona of run.personas) {
    let repeatViolations = 0;
    let exhaustedViolations = 0;
    for (const move of persona.moves) {
      if (!systemChosen(move)) continue;
      const repeated = new Set(move.offers.filter((offer) => offer.alreadyMet).map((offer) => offer.unitId));
      if (move.outcome === 'ready' && repeated.size > 0) {
        if (unseenWitnesses(run, move, repeated) > 0) repeatViolations += repeated.size;
        else lastResort.set(persona.persona, (lastResort.get(persona.persona) ?? 0) + 1);
      }
      if (move.outcome === 'exhausted' && unseenWitnesses(run, move, repeated) > 0) exhaustedViolations += 1;
    }
    if (repeatViolations > 0)
      violations.push({ code: 'repeat_while_unseen_exists', persona: persona.persona, count: repeatViolations });
    if (exhaustedViolations > 0)
      violations.push({ code: 'exhausted_while_unseen_exists', persona: persona.persona, count: exhaustedViolations });
  }
  return { violations, lastResort };
}

/** The most distinct qualified units any one series of this reader reached. */
export function seriesDepth(persona: PersonaRecord): number {
  const bySeries = new Map<string, Set<string>>();
  for (const encounter of persona.encounters) {
    if (encounter.seriesId === undefined || encounter.evidence !== 'qualified') continue;
    const units = bySeries.get(encounter.seriesId) ?? new Set<string>();
    units.add(encounter.unitId);
    bySeries.set(encounter.seriesId, units);
  }
  return Math.max(0, ...[...bySeries.values()].map((units) => units.size));
}

function readingChecks(persona: PersonaRecord): Violation[] {
  const reads = persona.encounters.filter((encounter) => encounter.attendance === 'read');
  const count = (matches: (encounter: EncounterRecord) => boolean): number => reads.filter(matches).length;
  const counted: [ViolationCode, number][] = [
    ['reading_not_stored', count((e) => e.rejected > 0 || e.notRecorded || e.accepted + e.duplicates === 0)],
    ['reading_not_projected', count((e) => e.evidence === 'not_projected')],
    ['reading_not_qualified', count((e) => e.evidence === 'not_qualified' || e.evidence === 'unknown')],
  ];
  return counted.flatMap(([code, n]) => (n > 0 ? [{ code, persona: persona.persona, count: n }] : []));
}

function formationChecks(persona: PersonaRecord): Violation[] {
  const depth = seriesDepth(persona);
  const found = persona.formation;
  if (found === undefined) return [];
  const out: Violation[] = [];
  if (depth >= SERIES_UNITS_FOR_SYSTEM && found.systems < 1)
    out.push({ code: 'formation_system_missing', persona: persona.persona, count: 1 });
  if (depth >= SERIES_UNITS_FOR_PLANET && found.planets < 1)
    out.push({ code: 'formation_planet_missing', persona: persona.persona, count: 1 });
  return out;
}

function reelChecks(run: CanaryRun): Violation[] {
  const reelsExist = run.personas.some((persona) =>
    persona.moves.some((move) => move.offers.some((offer) => offer.format === 'reel' || offer.readyReelVariant)),
  );
  const out: Violation[] = [];
  for (const persona of run.personas) {
    if (persona.persona !== 'reel-watcher' || !reelsExist) continue;
    if (!persona.encounters.some((encounter) => encounter.format === 'reel'))
      out.push({ code: 'reel_never_offered', persona: persona.persona, count: 1 });
  }
  return out;
}

function operatorChecks(reads: OperatorReads | undefined): Violation[] {
  if (reads === undefined) return [{ code: 'operator_reads_failed', count: 1 }];
  const out: Violation[] = [];
  const sum = (rows: readonly JobRow[]) => rows.reduce((total, row) => total + row.count, 0);
  const deadLettered = reads.jobs.filter((row) => row.queue.endsWith(DEAD_LETTER_SUFFIX));
  const failed = reads.jobs.filter((row) => row.state === 'failed' && !row.queue.endsWith(DEAD_LETTER_SUFFIX));
  if (sum(failed) > 0) out.push({ code: 'job_failed', count: sum(failed) });
  if (sum(deadLettered) > 0) out.push({ code: 'job_dead_lettered', count: sum(deadLettered) });
  const stuck = (rows: readonly RunRow[]) =>
    rows.filter(
      (row) =>
        !row.ended && row.state !== 'blocked' && row.state !== 'unknown' && row.ageSeconds > RUN_STUCK_AFTER_SECONDS,
    ).length;
  const unknown = reads.planner.filter((row) => row.state === 'unknown').length;
  if (unknown > 0) out.push({ code: 'planner_run_unknown', count: unknown });
  if (stuck(reads.planner) > 0) out.push({ code: 'planner_run_stuck', count: stuck(reads.planner) });
  if (stuck(reads.geography) > 0) out.push({ code: 'geography_run_stuck', count: stuck(reads.geography) });
  if (reads.supply.commissionedWork > 0)
    out.push({ code: 'shared_supply_touched', count: reads.supply.commissionedWork });
  return out;
}

export interface PersonaSummary {
  readonly persona: PersonaId;
  readonly moves: { readonly ready: number; readonly pending: number; readonly exhausted: number };
  readonly encounters: { readonly scroll: number; readonly reel: number; readonly glanced: number };
  readonly qualified: number;
  /** Readings whose evidence was still being projected when the wait ran out: neither green nor red. */
  readonly inconclusive: number;
  readonly observations: { readonly accepted: number; readonly duplicates: number; readonly rejected: number };
  readonly seriesDepth: number;
  readonly formation: FormationReading | null;
  /** Repeats served when nothing unseen was left: allowed, and counted so the owner can see how often. */
  readonly lastResortRepeats: number;
  readonly regionSwitch: PersonaRecord['regionSwitch'];
}

/**
 * `ok`: the invariant was exercised and held. `violated`: it was exercised and broke. `not_exercised`: what it
 * guards never happened in this run, so nothing was proved either way. `inconclusive`: its evidence was still being
 * projected when the wait ran out.
 */
export type CheckStatus = 'ok' | 'violated' | 'not_exercised' | 'inconclusive';

export interface Evaluation {
  /** No invariant was violated and, under `strict`, every one was exercised and conclusive. */
  readonly passed: boolean;
  readonly strict: boolean;
  readonly violations: readonly Violation[];
  /** Every invariant with its status and the number of violations it found, so a green run shows what was checked. */
  readonly checks: readonly {
    readonly code: ViolationCode;
    readonly status: CheckStatus;
    readonly count: number;
  }[];
  readonly notExercised: readonly ViolationCode[];
  readonly personas: readonly PersonaSummary[];
  readonly planner: Readonly<Record<string, number>>;
  readonly geography: Readonly<Record<string, number>>;
  readonly jobs: { readonly failed: number; readonly deadLettered: number };
  readonly composerPolicies: Readonly<Record<string, number>>;
  /** What the run asked of shared supply and of models, for the owner to see it cost nothing it should not. */
  readonly spend: {
    readonly supplyRequests: number;
    readonly commissionedWork: number;
    readonly modelAttempts: Readonly<Record<string, number>>;
  };
}

function tally(rows: readonly RunRow[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.state] = (counts[row.state] ?? 0) + 1;
  return counts;
}

function summaryOf(persona: PersonaRecord, lastResort: ReadonlyMap<PersonaId, number>): PersonaSummary {
  const count = (matches: (move: MoveRecord) => boolean) => persona.moves.filter(matches).length;
  const reads = (format: OfferFormat) =>
    persona.encounters.filter((encounter) => encounter.format === format && encounter.attendance === 'read').length;
  const sum = (pick: (encounter: EncounterRecord) => number) =>
    persona.encounters.reduce((total, encounter) => total + pick(encounter), 0);
  return {
    persona: persona.persona,
    moves: {
      ready: count((move) => move.outcome === 'ready'),
      pending: count((move) => move.outcome === 'pending'),
      exhausted: count((move) => move.outcome === 'exhausted'),
    },
    encounters: {
      scroll: reads('scroll'),
      reel: reads('reel'),
      glanced: persona.encounters.filter((encounter) => encounter.attendance === 'glance').length,
    },
    qualified: persona.encounters.filter((encounter) => encounter.evidence === 'qualified').length,
    inconclusive: persona.encounters.filter((encounter) => encounter.evidence === 'inconclusive').length,
    observations: {
      accepted: sum((e) => e.accepted),
      duplicates: sum((e) => e.duplicates),
      rejected: sum((e) => e.rejected),
    },
    seriesDepth: seriesDepth(persona),
    formation: persona.formation ?? null,
    lastResortRepeats: lastResort.get(persona.persona) ?? 0,
    regionSwitch: persona.regionSwitch,
  };
}

/** Whether anything in the run could have broken the invariant: what it guards happened at least once. */
function exercised(code: ViolationCode, run: CanaryRun): boolean {
  const personas = run.personas;
  const moves = personas.flatMap((persona) => persona.moves);
  const reads = run.reads;
  const readEncounters = personas.flatMap((persona) =>
    persona.encounters.filter((encounter) => encounter.attendance === 'read'),
  );
  switch (code) {
    case 'first_offer_missing':
    case 'api_refused':
      return personas.length > 0;
    case 'repeat_while_unseen_exists':
      // A system-chosen move asked after the reader had met something: the only place a re-read can happen.
      return moves.some((move) => systemChosen(move) && move.metBefore.length > 0 && move.outcome !== 'pending');
    case 'exhausted_while_unseen_exists':
      return moves.some((move) => systemChosen(move) && move.outcome === 'exhausted');
    case 'reel_never_offered':
      return (
        personas.some((persona) => persona.persona === 'reel-watcher') &&
        moves.some((move) => move.offers.some((offer) => offer.format === 'reel' || offer.readyReelVariant))
      );
    case 'reading_not_stored':
    case 'reading_not_projected':
    case 'reading_not_qualified':
      return readEncounters.length > 0;
    case 'formation_system_missing':
      return personas.some(
        (persona) => persona.formation !== undefined && seriesDepth(persona) >= SERIES_UNITS_FOR_SYSTEM,
      );
    case 'formation_planet_missing':
      return personas.some(
        (persona) => persona.formation !== undefined && seriesDepth(persona) >= SERIES_UNITS_FOR_PLANET,
      );
    case 'reel_media_unreachable':
      return personas.some((persona) => persona.media.checked > 0);
    case 'operator_reads_failed':
      return true;
    case 'job_failed':
    case 'job_dead_lettered':
    case 'shared_supply_touched':
      return reads !== undefined;
    case 'planner_run_unknown':
    case 'planner_run_stuck':
      // A Planner that is switched off only parks its runs (`blocked`); then nothing about it was tested.
      return reads !== undefined && reads.planner.some((row) => row.state !== 'blocked');
    case 'geography_run_stuck':
      return reads !== undefined && reads.geography.length > 0;
    case 'cleanup_incomplete':
      return !run.cleanup.kept;
  }
}

/** Judges a run. Passed means no invariant was violated; the summaries carry counts and codes only. */
export function evaluateCanary(run: CanaryRun, options: { readonly strict?: boolean } = {}): Evaluation {
  const strict = options.strict === true;
  const rereads = noRereads(run);
  const violations: Violation[] = [...rereads.violations];
  for (const persona of run.personas) {
    if (persona.moves[0]?.outcome !== 'ready')
      violations.push({ code: 'first_offer_missing', persona: persona.persona, count: 1 });
    violations.push(...readingChecks(persona), ...formationChecks(persona));
    if (persona.media.failed > 0)
      violations.push({ code: 'reel_media_unreachable', persona: persona.persona, count: persona.media.failed });
    if (persona.problems.length > 0)
      violations.push({ code: 'api_refused', persona: persona.persona, count: persona.problems.length });
  }
  violations.push(...reelChecks(run), ...operatorChecks(run.reads));
  if (!run.cleanup.kept && run.cleanup.completed < run.cleanup.requested)
    violations.push({ code: 'cleanup_incomplete', count: run.cleanup.requested - run.cleanup.completed });

  const total = (code: ViolationCode) =>
    violations.filter((violation) => violation.code === code).reduce((sum, violation) => sum + violation.count, 0);
  const anyInconclusive = run.personas.some((persona) =>
    persona.encounters.some((encounter) => encounter.evidence === 'inconclusive'),
  );
  const statusOf = (code: ViolationCode): CheckStatus => {
    if (total(code) > 0) return 'violated';
    if (!exercised(code, run)) return 'not_exercised';
    const waitsOnEvidence = code === 'reading_not_projected' || code === 'reading_not_qualified';
    return waitsOnEvidence && anyInconclusive ? 'inconclusive' : 'ok';
  };
  const checks = VIOLATION_CODES.map((code) => ({ code, status: statusOf(code), count: total(code) }));
  const notExercised = checks.filter((check) => check.status === 'not_exercised').map((check) => check.code);
  const unfinished = notExercised.length > 0 || checks.some((check) => check.status === 'inconclusive');

  const jobs = run.reads?.jobs ?? [];
  const jobCount = (dead: boolean) =>
    jobs
      .filter((row) => row.queue.endsWith(DEAD_LETTER_SUFFIX) === dead && (dead || row.state === 'failed'))
      .reduce((sum, row) => sum + row.count, 0);
  return {
    passed: violations.length === 0 && !(strict && unfinished),
    strict,
    violations,
    checks,
    notExercised,
    personas: run.personas.map((persona) => summaryOf(persona, rereads.lastResort)),
    planner: tally(run.reads?.planner ?? []),
    geography: tally(run.reads?.geography ?? []),
    jobs: { failed: jobCount(false), deadLettered: jobCount(true) },
    composerPolicies: Object.fromEntries((run.reads?.policies ?? []).map((row) => [row.label, row.count])),
    spend: {
      supplyRequests: run.reads?.supply.requests ?? 0,
      commissionedWork: run.reads?.supply.commissionedWork ?? 0,
      modelAttempts: Object.fromEntries((run.reads?.attempts ?? []).map((row) => [row.role, row.count])),
    },
  };
}
