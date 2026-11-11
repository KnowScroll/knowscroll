import { sql } from 'kysely';
import type { ComposerDecision } from '@knowscroll/backend/modules/composer';
import { CONCEPTS } from '@knowscroll/backend/modules/content';
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
      'No job fails or is dead-lettered, no Planner or Cartographer run is held queued, and every drain settles.',
  },
  I4: {
    name: 'only real encounters create evidence',
    statement:
      'Evidence exists only for encounters the person activated and reported; play, offers, buffers, demand, a pause and another person never create it, and a reading is qualified exactly when it should be.',
  },
  I5: {
    name: 'bounded cost',
    statement: 'Composer decisions, Geography runs and Planner runs per encounter stay within the stated bounds.',
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

export async function evaluate(world: SimWorld, result: PersonaResult): Promise<Violation[]> {
  return [
    ...(await repeatsWhileUnseen(world, result)),
    ...formation(world, result),
    ...workCompletes(world, result),
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
      const cause = await repeatCause(world, move, slot);
      violations.push({
        invariant: 'I1',
        code: 'met_offered_while_unseen_left',
        persona: run.spec.id,
        message: `${run.spec.id} was offered ${offer.unitId} (${offer.kind}, slot ${String(slot)}) at move ${String(move.index)}, a unit it had already met, while ${String(move.unseenLeftOut)} unseen units were left out of the answer (${cause}).`,
        detail: {
          move: move.index,
          slot,
          unit: offer.unitId,
          kind: offer.kind,
          unseenLeftOut: move.unseenLeftOut,
          cause,
        },
      });
    }
  }
  return violations;
}

async function repeatCause(
  world: SimWorld,
  move: PersonaResult['run']['moves'][number],
  slot: number,
): Promise<RepeatCause> {
  if (move.decisionId === undefined) return 'unknown';
  const row = (
    await sql<{
      payload: ComposerDecision;
    }>`select payload from composer.decisions where id = ${move.decisionId}::uuid`.execute(world.geo.database.db)
  ).rows[0];
  if (!row) return 'unknown';
  const decision = row.payload;
  if (slot === 0 && decision.exploration.branch === 'explore') return 'exploration_draw';
  const met = new Set(move.metBefore);
  const unseen = decision.evaluations.filter((evaluation) => !met.has(evaluation.explanationUnitId));
  // The met unit reached the offer without any rule excluding it: it was eligible and simply scored higher.
  const offered = decision.evaluations.find((evaluation) => evaluation.explanationUnitId === move.offers[slot]!.unitId);
  if (offered === undefined || !offered.eligible) return 'unknown';
  if (unseen.some((evaluation) => evaluation.eligible)) return 'soft_penalty';
  if (unseen.length === 0) return 'retrieval';
  if (unseen.every((evaluation) => evaluation.exclusions.includes('format_sticky'))) return 'format_sticky';
  return 'other_exclusion';
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

function workCompletes(_world: SimWorld, result: PersonaResult): Violation[] {
  const { run, db } = result;
  const persona = run.spec.id;
  const violations: Violation[] = [];
  const topics = new Set(run.encounters.map((encounter) => encounter.offer.topicId)).size;
  for (const job of db.stuckJobs) {
    // A dead-letter copy repeats a failed job, so only the original is reported.
    if (job.queue.endsWith('.dead')) continue;
    violations.push({
      invariant: 'I3',
      code: job.state === 'failed' ? 'job_failed' : 'job_not_completed',
      persona,
      message: `${persona}: ${String(job.n)} ${job.queue} job(s) ${job.state}${job.errorClass ? ` (${job.errorClass}${job.code ? ` ${job.code}` : ''})` : ''} with ${String(topics)} distinct topics met.`,
      detail: {
        queue: job.queue,
        state: job.state,
        count: job.n,
        topics,
        // What the handler threw, as the lab saw it (pg-boss keeps only a class and a code).
        message: run.drains.errors[job.queue]?.[0] ?? null,
        ...(job.errorClass ? { errorClass: job.errorClass } : {}),
      },
    });
  }
  for (const [kind, runs] of [
    ['planner', db.plannerRuns],
    ['geography', db.geographyRuns],
  ] as const)
    for (const held of runs.filter((entry) => entry.status === 'queued' || entry.status === 'prepared'))
      violations.push({
        invariant: 'I3',
        code: 'run_held_queued',
        persona,
        message: `${persona}: ${String(held.n)} ${kind} run(s) still ${held.status} after the worker drained, with ${String(topics)} distinct topics met.`,
        detail: {
          kind,
          status: held.status,
          count: held.n,
          topics,
          message: run.drains.errors[`${kind}.run`]?.[0] ?? null,
        },
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
  // A Like or Save is an activity change that wakes Geography and the Planner like a reading does; the lab's drains do
  // not wait out the 30 second pacing that would coalesce them.
  const activityChanges = Math.max(run.encounters.length, run.moves.length) + run.likes.length;
  const violations: Violation[] = [];
  const check = (what: string, count: number, perEncounter: number, code: string) => {
    // One run may be in flight before the first encounter ends, so the bound allows one extra.
    if (count > perEncounter * activityChanges + 1)
      violations.push({
        invariant: 'I5',
        code,
        persona,
        message: `${persona}: ${String(count)} ${what} for ${String(run.encounters.length)} encounters and ${String(run.likes.length)} Likes or Saves exceeds ${String(perEncounter)} per activity change.`,
        detail: { count, encounters: run.encounters.length, activityChanges, bound: perEncounter },
      });
  };
  check('Composer decisions', db.decisions, bounds.decisionsPerEncounter, 'decisions_unbounded');
  check(
    'Geography runs',
    db.geographyRuns.reduce((sum, row) => sum + row.n, 0),
    bounds.geographyRunsPerQualified,
    'geography_runs_unbounded',
  );
  check(
    'Planner runs',
    db.plannerRuns.reduce((sum, row) => sum + row.n, 0),
    bounds.plannerRunsPerQualified,
    'planner_runs_unbounded',
  );
  return violations;
}
