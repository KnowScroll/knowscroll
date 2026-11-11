import { sql } from 'kysely';
import type { ComposerDecision } from '@knowscroll/backend/modules/composer';
import { CONCEPTS } from '@knowscroll/backend/modules/content';
import { unsettledJobs } from './collect.js';
import type { PersonaResult } from './run.js';
import type { SimWorld } from './world.js';

export type InvariantId = 'I1' | 'I2' | 'I3' | 'I4' | 'I5';

export const INVARIANTS: Readonly<Record<InvariantId, { readonly name: string; readonly statement: string }>> = {
  I1: {
    name: 'no repeat while something unseen exists',
    statement:
      'A system-chosen offer never repeats an explanation the person has already met, in either format, while an unseen eligible one exists.',
  },
  I2: {
    name: 'formation',
    statement:
      'When a person qualified enough distinct explanations, the system or planet forms within a bounded number of drains, and no Geography run settles coverage_unavailable while trusted supports exist.',
  },
  I3: {
    name: 'work completes',
    statement:
      'No job handler throws (even one a retry recovers), no job is left unfinished or dead-lettered whatever its payload names, no Planner or Cartographer run is held queued, and every drain settles.',
  },
  I4: {
    name: 'only real encounters create evidence',
    statement:
      "Evidence exists only for encounters the person activated and reported; play, offers, buffers, demand, a pause and another person never create it or change the person's evidence, places, offers, plans or demand, and a reading is qualified exactly when it should be.",
  },
  I5: {
    name: 'bounded cost',
    statement:
      'Composer decisions per move, and Geography and Planner runs per activity change, stay within the stated bounds.',
  },
};

/** One thing a persona's run did that an invariant forbids. `code` is stable; `detail` says why. */
export interface Violation {
  readonly invariant: InvariantId;
  readonly code: string;
  readonly persona: string;
  readonly message: string;
  readonly detail: Readonly<Record<string, unknown>>;
}

/** Why an already-met explanation reached an offer while an unseen one was left out, read from the stored decision. */
export type RepeatCause =
  'exploration_draw' | 'format_sticky' | 'soft_penalty' | 'retrieval' | 'other_exclusion' | 'unknown';

/** Planet formation needs this many distinct units over this many facets, a system this many units (policy.ts of Geography). */
const FORMATION = { systemUnits: 2, planetUnits: 3, planetFacets: 2 } as const;

export async function evaluate(
  world: SimWorld,
  result: PersonaResult,
  results: readonly PersonaResult[],
): Promise<Violation[]> {
  return [
    ...(await repeatsWhileUnseen(world, result)),
    ...formation(world, result),
    ...workCompletes(result, results),
    ...onlyRealEncounters(world, result),
    ...boundedCost(world, result),
  ];
}

// --- I1 -----------------------------------------------------------------------------------------------------------

async function repeatsWhileUnseen(world: SimWorld, result: PersonaResult): Promise<Violation[]> {
  const { run } = result;
  const violations: Violation[] = [];
  for (const move of run.moves) {
    // A region or a link the person opened is their own ask for that place, not a subject the system chose.
    if (move.status !== 'ready' || (move.move !== 'discover' && move.move !== 'vertical') || move.unseenLeftOut === 0)
      continue;
    for (const [slot, offer] of move.offers.entries()) {
      if (!offer.alreadyMet) continue;
      const { cause, candidates } = await repeatCause(world, move, slot);
      violations.push({
        invariant: 'I1',
        code: 'met_offered_while_unseen_left',
        persona: run.spec.id,
        message: `${run.spec.id} was offered ${offer.unitId} (${offer.kind}, slot ${String(slot)}) at move ${String(move.index)}, a unit it had already met, while ${String(move.unseenLeftOut)} unseen units were left out of the answer (${cause}; the decision evaluated ${String(candidates.ofFormat)} ${offer.kind} candidates, ${String(candidates.total)} in all).`,
        detail: {
          move: move.index,
          slot,
          unit: offer.unitId,
          kind: offer.kind,
          unseenLeftOut: move.unseenLeftOut,
          cause,
          // What retrieval handed the decision: whether it was capped is read from these, not from the library's size.
          candidatesOfFormat: candidates.ofFormat,
          candidatesEvaluated: candidates.total,
        },
      });
    }
  }
  return violations;
}

/** Why a met unit reached the offer, and how many candidates the decision evaluated (the offered format's, and all). */
interface RepeatAnalysis {
  readonly cause: RepeatCause;
  readonly candidates: { readonly ofFormat: number; readonly total: number };
}

async function repeatCause(
  world: SimWorld,
  move: PersonaResult['run']['moves'][number],
  slot: number,
): Promise<RepeatAnalysis> {
  const none = { ofFormat: 0, total: 0 };
  if (move.decisionId === undefined) return { cause: 'unknown', candidates: none };
  const row = (
    await sql<{
      payload: ComposerDecision;
    }>`select payload from composer.decisions where id = ${move.decisionId}::uuid`.execute(world.geo.database.db)
  ).rows[0];
  if (!row) return { cause: 'unknown', candidates: none };
  const decision = row.payload;
  const offer = move.offers[slot]!;
  const candidates = {
    ofFormat: decision.evaluations.filter(
      (evaluation) => world.library.ofAsset(evaluation.assetId)?.kind === offer.kind,
    ).length,
    total: decision.evaluations.length,
  };
  const analysed = (cause: RepeatCause): RepeatAnalysis => ({ cause, candidates });
  // Every cause below says "nothing excluded the met unit". That is only true if the decision evaluated this very asset
  // as eligible, so it is checked first, whatever route the offer took.
  const offered = decision.evaluations.find((evaluation) => evaluation.assetId === offer.assetId);
  if (offered === undefined || !offered.eligible) return analysed('unknown');
  if (slot === 0 && decision.exploration.branch === 'explore')
    return analysed(
      decision.exploration.pool.some((ref) => ref.assetId === offer.assetId) ? 'exploration_draw' : 'unknown',
    );
  const met = new Set(move.metBefore);
  const unseen = decision.evaluations.filter((evaluation) => !met.has(evaluation.explanationUnitId));
  const unseenEligible = unseen.filter((evaluation) => evaluation.eligible);
  if (unseenEligible.length > 0) {
    // The first slot of a ranked decision is its highest score, so an eligible unseen unit scoring higher is not a
    // soft penalty at work but something the lab does not understand, and it must not be absorbed.
    if (slot === 0 && unseenEligible.some((evaluation) => evaluation.score > offered.score)) return analysed('unknown');
    return analysed('soft_penalty');
  }
  if (unseen.length === 0) return analysed('retrieval');
  if (unseen.every((evaluation) => evaluation.exclusions.includes('format_sticky'))) return analysed('format_sticky');
  return analysed('other_exclusion');
}

// --- I2 -----------------------------------------------------------------------------------------------------------

function formation(world: SimWorld, result: PersonaResult): Violation[] {
  const { run, db } = result;
  const violations: Violation[] = [];
  const persona = run.spec.id;
  // Units the person qualified, with the evidence rules' own answer. Only reading that was recorded counts.
  const qualified = new Map<string, { scroll: boolean; reel: boolean }>();
  for (const encounter of run.encounters) {
    if (encounter.qualification !== 'qualified') continue;
    const entry = qualified.get(encounter.offer.unitId) ?? { scroll: false, reel: false };
    if (encounter.offer.kind === 'scroll') entry.scroll = true;
    else entry.reel = true;
    qualified.set(encounter.offer.unitId, entry);
  }
  const systemOf = (topicId: string) => CONCEPTS.find((concept) => concept.id === topicId)!.parent!;
  const places = new Set(db.places);
  // A system forms from two distinct qualified units under it, in either format (the equal-status rule).
  const bySystem = new Map<string, { all: string[]; scrollOnly: string[] }>();
  for (const [unitId, formats] of qualified) {
    const system = systemOf(world.library.unit(unitId).topicId);
    const entry = bySystem.get(system) ?? { all: [], scrollOnly: [] };
    entry.all.push(unitId);
    if (formats.scroll) entry.scrollOnly.push(unitId);
    bySystem.set(system, entry);
  }
  for (const [system, units] of bySystem) {
    if (units.all.length < FORMATION.systemUnits || places.has(`system:${system}:factual`)) continue;
    const onlyWithReels = units.scrollOnly.length < FORMATION.systemUnits;
    violations.push({
      invariant: 'I2',
      code: 'system_not_formed',
      persona,
      message: `${persona} qualified ${String(units.all.length)} distinct units under ${system}${onlyWithReels ? ` (${String(units.all.length - units.scrollOnly.length)} only as a Reel)` : ''} but no system formed after ${String(result.settleDrains)} settling drains.`,
      detail: { system, units: units.all, onlyWithReels },
    });
  }
  // A planet needs three distinct units over two facets of its topic, each read in a form that proves its facet (a Scroll).
  const byTopic = new Map<string, string[]>();
  for (const [unitId, formats] of qualified) {
    if (!formats.scroll) continue;
    const topic = world.library.unit(unitId).topicId;
    byTopic.set(topic, [...(byTopic.get(topic) ?? []), unitId]);
  }
  for (const [topic, units] of byTopic) {
    const facets = new Set(units.map((unitId) => world.library.unit(unitId).facetId));
    if (units.length < FORMATION.planetUnits || facets.size < FORMATION.planetFacets) continue;
    if (places.has(`planet:${topic}:factual`)) continue;
    violations.push({
      invariant: 'I2',
      code: 'planet_not_formed',
      persona,
      message: `${persona} qualified ${String(units.length)} distinct Scrolls over ${String(facets.size)} facets of ${topic} but no planet formed after ${String(result.settleDrains)} settling drains.`,
      detail: { topic, units },
    });
  }
  // No run may settle coverage_unavailable while Personal Context already holds trusted supports.
  for (let index = 1; index < run.formation.length; index++) {
    const before = run.formation[index - 1]!;
    const after = run.formation[index]!;
    if (
      before.trustedSupports > 0 &&
      after.trustedSupports > 0 &&
      after.coverageUnavailableRuns > before.coverageUnavailableRuns
    )
      violations.push({
        invariant: 'I2',
        code: 'coverage_unavailable_with_supports',
        persona,
        message: `${persona}: a Geography run settled coverage_unavailable after encounter ${String(after.encounter)} although ${String(after.trustedSupports)} trusted supports existed.`,
        detail: { encounter: after.encounter, trustedSupports: after.trustedSupports },
      });
  }
  return violations;
}

// --- I3 -----------------------------------------------------------------------------------------------------------

function workCompletes(result: PersonaResult, results: readonly PersonaResult[]): Violation[] {
  const { run, db } = result;
  const persona = run.spec.id;
  const violations: Violation[] = [];
  // A handler that threw is a failure even when pg-boss retried the job and the retry succeeded.
  for (const [queue, count] of Object.entries(run.drains.failures))
    violations.push({
      invariant: 'I3',
      code: 'job_handler_failed',
      persona,
      message: `${persona}: a ${queue} handler threw ${String(count)} time(s) while the lab drained (${run.drains.errors[queue]?.join('; ') ?? 'no message'}).`,
      detail: { queue, count, messages: run.drains.errors[queue] ?? [] },
    });
  for (const [kind, runs] of [
    ['planner', db.plannerRuns],
    ['geography', db.geographyRuns],
  ] as const)
    for (const held of runs.filter((entry) => entry.status === 'queued' || entry.status === 'prepared'))
      violations.push({
        invariant: 'I3',
        code: 'run_held_queued',
        persona,
        message: `${persona}: ${String(held.n)} ${kind} run(s) still ${held.status} after the worker drained.`,
        // The drain is global, so the throw that held this run may have been recorded by another persona's drain.
        detail: { kind, status: held.status, count: held.n, messages: thrownBy(results, `${kind}.run`) },
      });
  if (run.drains.exhausted)
    violations.push({
      invariant: 'I3',
      code: 'drain_did_not_settle',
      persona,
      message: `${persona}: a drain reached its round limit with work still arriving.`,
      detail: {},
    });
  return violations;
}

/**
 * What the handlers of a queue threw, whichever persona's drain ran them (a drain is global): pg-boss keeps only an error
 * class, so the lab keeps the messages.
 */
export function thrownBy(results: readonly PersonaResult[], queue: string): string[] {
  return [...new Set(results.flatMap((result) => result.run.drains.errors[queue] ?? []))];
}

/**
 * The checks of the world as a whole, once every persona has finished: no job anywhere is left unfinished, whatever its
 * payload looks like or whose it is, and none was dead-lettered. They belong to no one persona, so they carry `world`.
 */
export async function evaluateWorld(world: SimWorld, results: readonly PersonaResult[]): Promise<Violation[]> {
  const thrown = (queue: string) =>
    thrownBy(results, queue.endsWith('.dead') ? queue.slice(0, -'.dead'.length) : queue);
  return (await unsettledJobs(world.geo.database.db)).map((job) => ({
    invariant: 'I3' as const,
    code: job.queue.endsWith('.dead')
      ? 'job_dead_lettered'
      : job.state === 'failed'
        ? 'job_failed'
        : 'job_not_completed',
    persona: 'world',
    message: `${String(job.n)} ${job.queue} job(s) ${job.state}${job.errorClass ? ` (${job.errorClass})` : ''} when the lab finished${thrown(job.queue).length > 0 ? `: ${thrown(job.queue).join('; ')}` : ''}.`,
    detail: {
      queue: job.queue,
      state: job.state,
      count: job.n,
      messages: thrown(job.queue),
      ...(job.errorClass ? { errorClass: job.errorClass } : {}),
    },
  }));
}

// --- I4 -----------------------------------------------------------------------------------------------------------

function onlyRealEncounters(world: SimWorld, result: PersonaResult): Violation[] {
  const { run, db } = result;
  const persona = run.spec.id;
  const violations: Violation[] = [];
  const reported = run.reportedExposures;
  for (const exposureId of db.evidenceExposures)
    if (!reported.has(exposureId))
      violations.push({
        invariant: 'I4',
        code: 'evidence_without_report',
        persona,
        message: `${persona}: evidence exists for exposure ${exposureId}, which the person never reported reading.`,
        detail: { exposureId },
      });
  for (const exposureId of db.observationExposures)
    if (!run.activatedExposures.includes(exposureId))
      violations.push({
        invariant: 'I4',
        code: 'observation_without_activation',
        persona,
        message: `${persona}: observations are stored for exposure ${exposureId}, which was never activated.`,
        detail: { exposureId },
      });
  if (db.activatedExposures !== run.activatedExposures.length)
    violations.push({
      invariant: 'I4',
      code: 'exposures_differ_from_activations',
      persona,
      message: `${persona} activated ${String(run.activatedExposures.length)} offers but the database holds ${String(db.activatedExposures)} activated exposures; an offer, a buffer or a preview must not create one.`,
      detail: { activated: run.activatedExposures.length, stored: db.activatedExposures },
    });
  // Personal Context may count a qualified unit only under a topic the person qualified a reading of.
  const qualifiedTopics = new Set(
    run.encounters
      .filter((encounter) => encounter.qualification === 'qualified')
      .map((encounter) => encounter.offer.topicId),
  );
  for (const topic of db.contextTopics)
    if (!qualifiedTopics.has(topic))
      violations.push({
        invariant: 'I4',
        code: 'context_without_qualified_reading',
        persona,
        message: `${persona}: Personal Context counts a qualified unit under ${topic}, which the person never qualified a reading of.`,
        detail: { topic },
      });
  for (const encounter of run.encounters) {
    const answered = encounter.qualification;
    if (!encounter.recorded) {
      if (answered !== undefined)
        violations.push({
          invariant: 'I4',
          code: 'evidence_while_paused',
          persona,
          message: `${persona}: encounter ${String(encounter.index)} was read while recording was paused, yet evidence exists for it.`,
          detail: { encounter: encounter.index, qualification: answered },
        });
      continue;
    }
    if (encounter.events === 0) continue;
    if (answered === undefined) {
      violations.push({
        invariant: 'I4',
        code: 'reading_not_projected',
        persona,
        message: `${persona}: encounter ${String(encounter.index)} reported ${String(encounter.events)} events but no evidence was committed for it.`,
        detail: { encounter: encounter.index },
      });
      continue;
    }
    if (encounter.expectQualified !== (answered === 'qualified'))
      violations.push({
        invariant: 'I4',
        code: 'reading_misqualified',
        persona,
        message: `${persona}: encounter ${String(encounter.index)} was a ${encounter.reading} of ${encounter.offer.unitId} (${encounter.offer.kind}) that should ${encounter.expectQualified ? '' : 'not '}qualify, and the evidence rules said ${answered}.`,
        detail: {
          encounter: encounter.index,
          reading: encounter.reading,
          expected: encounter.expectQualified,
          answered,
        },
      });
  }
  for (const breach of result.isolationBreaches)
    violations.push({
      invariant: 'I4',
      code: 'foreign_activity_changed_rows',
      persona,
      message: `${persona}: a step of ${breach.actor} changed ${persona}'s rows in ${breach.tables.join(', ')}.`,
      detail: { actor: breach.actor, tables: breach.tables },
    });
  return violations;
}

// --- I5 -----------------------------------------------------------------------------------------------------------

function boundedCost(world: SimWorld, result: PersonaResult): Violation[] {
  const { run, db } = result;
  const { bounds } = world.config;
  const persona = run.spec.id;
  // Every move the person makes asks the Composer, and every activation prepares a buffer: two decisions at most per move.
  // Reading and a Like or a Save each change the person's activity and wake Geography and the Planner; the lab's drains
  // do not wait out the 30 second pacing that would coalesce them.
  const moves = run.moves.length;
  const activityChanges = run.encounters.length + run.likes.length;
  const violations: Violation[] = [];
  const check = (what: string, count: number, perUnit: number, unit: string, units: number, code: string) => {
    // One run may be in flight before the first encounter ends, so the bound allows one extra.
    if (count > perUnit * units + 1)
      violations.push({
        invariant: 'I5',
        code,
        persona,
        message: `${persona}: ${String(count)} ${what} for ${String(units)} ${unit}s exceeds ${String(perUnit)} per ${unit}.`,
        detail: { count, units, unit, bound: perUnit },
      });
  };
  check('Composer decisions', db.decisions, bounds.decisionsPerMove, 'move', moves, 'decisions_unbounded');
  check(
    'Geography runs',
    db.geographyRuns.reduce((sum, row) => sum + row.n, 0),
    bounds.geographyRunsPerActivityChange,
    'activity change',
    activityChanges,
    'geography_runs_unbounded',
  );
  check(
    'Planner runs',
    db.plannerRuns.reduce((sum, row) => sum + row.n, 0),
    bounds.plannerRunsPerActivityChange,
    'activity change',
    activityChanges,
    'planner_runs_unbounded',
  );
  return violations;
}
