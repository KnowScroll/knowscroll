import { describe, expect, it } from 'vitest';
import {
  RUN_STUCK_AFTER_SECONDS,
  VIOLATION_CODES,
  evaluateCanary,
  runsPending,
  seriesDepth,
  type CanaryRun,
  type EncounterRecord,
  type MoveRecord,
  type OfferRecord,
  type OperatorReads,
  type PersonaRecord,
  type ViolationCode,
} from './evaluate.js';
import type { PersonaId } from './personas.js';

const offer = (unitId: string, extra: Partial<OfferRecord> = {}): OfferRecord => ({
  unitId,
  format: 'scroll',
  relation: 'discovery',
  seriesId: undefined,
  alreadyMet: false,
  readyReelVariant: false,
  ...extra,
});

const move = (
  mode: MoveRecord['mode'],
  offers: readonly OfferRecord[],
  extra: Partial<MoveRecord> = {},
): MoveRecord => ({
  mode,
  outcome: offers.length > 0 ? 'ready' : 'exhausted',
  offers,
  metBefore: [],
  sourceSeriesId: undefined,
  retries: 0,
  ...extra,
});

const encounter = (unitId: string, extra: Partial<EncounterRecord> = {}): EncounterRecord => ({
  unitId,
  format: 'scroll',
  attendance: 'read',
  seriesId: undefined,
  accepted: 3,
  duplicates: 0,
  rejected: 0,
  notRecorded: false,
  evidence: 'qualified',
  ...extra,
});

const persona = (id: PersonaId, extra: Partial<PersonaRecord> = {}): PersonaRecord => ({
  persona: id,
  moves: [move('discover', [offer(`${id}-first`)])],
  encounters: [encounter(`${id}-first`)],
  problems: [],
  formation: { dust: 1, systems: 0, planets: 0, regions: 0 },
  media: { checked: 0, failed: 0 },
  regionSwitch: 'not_attempted',
  ...extra,
});

const calm: OperatorReads = {
  planner: [{ state: 'accepted', ended: true, ageSeconds: 100 }],
  geography: [{ state: 'accepted', ended: true, ageSeconds: 100 }],
  jobs: [],
  policies: [{ label: 'composer-policy.v2', count: 4 }],
};

const run = (personas: readonly PersonaRecord[], extra: Partial<CanaryRun> = {}): CanaryRun => ({
  personas,
  reads: calm,
  cleanup: { kept: false, requested: personas.length, completed: personas.length },
  ...extra,
});

const codes = (r: CanaryRun): ViolationCode[] => evaluateCanary(r).violations.map((violation) => violation.code);

describe('canary evaluator', () => {
  it('passes a clean run and lists every invariant it checked as ok', () => {
    const evaluation = evaluateCanary(run([persona('cold-start'), persona('deep-reader')]));
    expect(evaluation.passed).toBe(true);
    expect(evaluation.violations).toEqual([]);
    expect(evaluation.checks.map((check) => check.code)).toEqual(VIOLATION_CODES);
    expect(evaluation.checks.every((check) => check.status === 'ok' && check.count === 0)).toBe(true);
    expect(evaluation.composerPolicies).toEqual({ 'composer-policy.v2': 4 });
  });

  describe('a first offer', () => {
    it('is missing when the first open is not ready', () => {
      const bad = persona('cold-start', { moves: [move('discover', [], { outcome: 'pending' })] });
      expect(codes(run([bad]))).toContain('first_offer_missing');
    });
  });

  describe('no re-reads while anything unseen exists (owner rule)', () => {
    const met = move('vertical', [offer('u-met', { alreadyMet: true })], { metBefore: ['u-met'] });
    const reader = persona('many-reads', { moves: [move('discover', [offer('u-met')]), met] });

    it('fires when an offer repeats a unit the reader met while another canary reader was offered one it had not', () => {
      const other = persona('cold-start', { moves: [move('discover', [offer('u-elsewhere')])] });
      const evaluation = evaluateCanary(run([reader, other]));
      expect(evaluation.violations).toContainEqual({
        code: 'repeat_while_unseen_exists',
        persona: 'many-reads',
        count: 1,
      });
      expect(evaluation.personas.find((p) => p.persona === 'many-reads')?.lastResortRepeats).toBe(0);
    });

    it('is a last resort, counted but allowed, when no other unit was ever offered', () => {
      const evaluation = evaluateCanary(run([reader]));
      expect(evaluation.violations.map((v) => v.code)).not.toContain('repeat_while_unseen_exists');
      expect(evaluation.personas[0]?.lastResortRepeats).toBe(1);
    });

    it('does not count a unit the reader itself had met as unseen', () => {
      const other = persona('cold-start', { moves: [move('discover', [offer('u-met')])] });
      expect(codes(run([reader, other]))).not.toContain('repeat_while_unseen_exists');
    });

    it('leaves out the series the reader moved from, which a subject move leaves', () => {
      const seriesRepeat = persona('many-reads', {
        moves: [
          move('discover', [offer('u-met')]),
          move('vertical', [offer('u-met', { alreadyMet: true })], {
            metBefore: ['u-met'],
            sourceSeriesId: 'series-1',
          }),
        ],
      });
      const sameSeries = persona('cold-start', {
        moves: [move('discover', [offer('u-part-2', { seriesId: 'series-1' })])],
      });
      expect(codes(run([seriesRepeat, sameSeries]))).not.toContain('repeat_while_unseen_exists');
    });

    it('does not bind the moves a reader asks for: a series part, a variant or a region', () => {
      const asked = persona('many-reads', {
        moves: [
          move('discover', [offer('u-met')]),
          move('series', [offer('u-met', { alreadyMet: true })], { metBefore: ['u-met'] }),
          move('variant', [offer('u-met', { alreadyMet: true, format: 'reel' })], { metBefore: ['u-met'] }),
          move('region', [offer('u-met', { alreadyMet: true })], { metBefore: ['u-met'] }),
        ],
      });
      const other = persona('cold-start', { moves: [move('discover', [offer('u-elsewhere')])] });
      expect(codes(run([asked, other]))).not.toContain('repeat_while_unseen_exists');
    });

    it('also binds the prepared offers, not only the chosen one', () => {
      const buffered = persona('many-reads', {
        moves: [
          move('discover', [offer('u-met')]),
          move('vertical', [offer('u-new'), offer('u-met', { alreadyMet: true })], { metBefore: ['u-met'] }),
        ],
      });
      const other = persona('cold-start', { moves: [move('discover', [offer('u-elsewhere')])] });
      expect(codes(run([buffered, other]))).toContain('repeat_while_unseen_exists');
    });

    it('fires when the system says nothing is left while another reader was offered something the reader had not met', () => {
      const exhausted = persona('many-reads', {
        moves: [move('discover', [offer('u-1')]), move('vertical', [], { metBefore: ['u-1'] })],
      });
      const other = persona('cold-start', { moves: [move('discover', [offer('u-2')])] });
      expect(codes(run([exhausted, other]))).toContain('exhausted_while_unseen_exists');
      expect(codes(run([exhausted]))).not.toContain('exhausted_while_unseen_exists');
    });
  });

  describe('reels', () => {
    it('fires when the reel watcher never opened a Reel though Reels were offered', () => {
      const watcher = persona('reel-watcher');
      const other = persona('cold-start', {
        moves: [move('discover', [offer('u-a', { readyReelVariant: true })])],
      });
      expect(codes(run([watcher, other]))).toContain('reel_never_offered');
      const happy = persona('reel-watcher', { encounters: [encounter('u-r', { format: 'reel' })] });
      expect(codes(run([happy, other]))).not.toContain('reel_never_offered');
    });

    it('does not fire when no Reel exists anywhere the canary looked', () => {
      expect(codes(run([persona('reel-watcher'), persona('cold-start')]))).not.toContain('reel_never_offered');
    });

    it('fires when a grant did not serve its bytes', () => {
      const bad = persona('reel-watcher', { media: { checked: 2, failed: 1 } });
      expect(evaluateCanary(run([bad])).violations).toContainEqual({
        code: 'reel_media_unreachable',
        persona: 'reel-watcher',
        count: 1,
      });
    });
  });

  describe('a reading that should qualify', () => {
    const only = (extra: Partial<EncounterRecord>) =>
      run([persona('cold-start', { encounters: [encounter('u', extra)] })]);

    it('is not stored when events were rejected, not recorded or never accepted', () => {
      expect(codes(only({ rejected: 1 }))).toContain('reading_not_stored');
      expect(codes(only({ notRecorded: true }))).toContain('reading_not_stored');
      expect(codes(only({ accepted: 0, duplicates: 0 }))).toContain('reading_not_stored');
      expect(codes(only({ accepted: 0, duplicates: 3 }))).not.toContain('reading_not_stored');
    });

    it('is not projected when evidence never appeared', () => {
      expect(codes(only({ evidence: 'not_projected' }))).toContain('reading_not_projected');
    });

    it('is not qualified when the server judged it short or unknown', () => {
      expect(codes(only({ evidence: 'not_qualified' }))).toContain('reading_not_qualified');
      expect(codes(only({ evidence: 'unknown' }))).toContain('reading_not_qualified');
    });

    it('is not judged for a glance, which reports nothing', () => {
      expect(codes(only({ attendance: 'glance', accepted: 0, evidence: 'not_applicable' }))).toEqual([]);
    });
  });

  describe('formation', () => {
    const series = (count: number): EncounterRecord[] =>
      Array.from({ length: count }, (_, index) => encounter(`part-${String(index)}`, { seriesId: 's-1' }));
    const reading = (systems: number, planets: number) => ({ dust: 0, systems, planets, regions: 0 });

    it('counts the distinct qualified units of the deepest series', () => {
      expect(seriesDepth(persona('deep-reader', { encounters: series(3) }))).toBe(3);
      expect(
        seriesDepth(
          persona('deep-reader', {
            encounters: [...series(2), encounter('part-0', { seriesId: 's-1' }), encounter('x')],
          }),
        ),
      ).toBe(2);
      expect(
        seriesDepth(persona('deep-reader', { encounters: [encounter('a', { seriesId: 's', evidence: 'unknown' })] })),
      ).toBe(0);
    });

    it('is due a system after two qualified units of one series, and a planet after three', () => {
      const two = persona('deep-reader', { encounters: series(2), formation: reading(0, 0) });
      expect(codes(run([two]))).toContain('formation_system_missing');
      expect(codes(run([two]))).not.toContain('formation_planet_missing');
      const three = persona('deep-reader', { encounters: series(3), formation: reading(1, 0) });
      expect(codes(run([three]))).toContain('formation_planet_missing');
      expect(codes(run([three]))).not.toContain('formation_system_missing');
    });

    it('is satisfied with the place the rules entitle, and due nothing for units of different series', () => {
      expect(codes(run([persona('deep-reader', { encounters: series(3), formation: reading(1, 1) })]))).toEqual([]);
      const scattered = persona('many-reads', {
        encounters: [
          encounter('a', { seriesId: 's-1' }),
          encounter('b', { seriesId: 's-2' }),
          encounter('c', { seriesId: 's-3' }),
        ],
        formation: reading(0, 0),
      });
      expect(codes(run([scattered]))).toEqual([]);
    });
  });

  it('reports a refused route as api_refused, with the count', () => {
    const refused = persona('cold-start', {
      problems: [
        { route: 'experience.activate', status: 409, code: 'INTENT_REVISION_STALE' },
        { route: 'canary', status: 0, code: 'unexpected' },
      ],
    });
    expect(evaluateCanary(run([refused])).violations).toContainEqual({
      code: 'api_refused',
      persona: 'cold-start',
      count: 2,
    });
  });

  describe('operator reads', () => {
    const withReads = (reads: Partial<OperatorReads> | undefined) =>
      run([persona('cold-start')], { reads: reads === undefined ? undefined : { ...calm, ...reads } });

    it('fail the run when they could not be read', () => {
      expect(codes(withReads(undefined))).toEqual(['operator_reads_failed']);
    });

    it('fail on a failed job and on a dead-lettered one, counted apart', () => {
      const evaluation = evaluateCanary(
        withReads({
          jobs: [
            { queue: 'evidence.project-reading', state: 'failed', count: 2 },
            { queue: 'evidence.project-reading.dead', state: 'completed', count: 1 },
            { queue: 'evidence.project-reading.dead', state: 'failed', count: 1 },
          ],
        }),
      );
      expect(evaluation.violations).toEqual([
        { code: 'job_failed', count: 2 },
        { code: 'job_dead_lettered', count: 2 },
      ]);
      expect(evaluation.jobs).toEqual({ failed: 2, deadLettered: 2 });
    });

    it('fail on a Planner run of unknown outcome, and on one stuck queued past the bound', () => {
      const stuck = RUN_STUCK_AFTER_SECONDS + 1;
      const evaluation = evaluateCanary(
        withReads({
          planner: [
            { state: 'unknown', ended: false, ageSeconds: 5 },
            { state: 'queued', ended: false, ageSeconds: stuck },
            { state: 'queued', ended: false, ageSeconds: 30 },
            { state: 'blocked', ended: false, ageSeconds: stuck },
            { state: 'insufficient', ended: true, ageSeconds: stuck },
          ],
        }),
      );
      expect(evaluation.violations).toEqual([
        { code: 'planner_run_unknown', count: 1 },
        { code: 'planner_run_stuck', count: 1 },
      ]);
      expect(evaluation.planner).toEqual({ unknown: 1, queued: 2, blocked: 1, insufficient: 1 });
    });

    it('fail on a Cartographer run stuck in a state that never settles', () => {
      expect(
        codes(withReads({ geography: [{ state: 'queued', ended: false, ageSeconds: RUN_STUCK_AFTER_SECONDS + 1 }] })),
      ).toEqual(['geography_run_stuck']);
    });

    it('know which runs are still on their way', () => {
      expect(runsPending({ ...calm })).toBe(false);
      expect(runsPending({ ...calm, planner: [{ state: 'queued', ended: false, ageSeconds: 4 }] })).toBe(true);
      expect(runsPending({ ...calm, geography: [{ state: 'prepared', ended: false, ageSeconds: 4 }] })).toBe(true);
      expect(
        runsPending({
          ...calm,
          planner: [
            { state: 'blocked', ended: false, ageSeconds: 4 },
            { state: 'unknown', ended: false, ageSeconds: 4 },
          ],
        }),
      ).toBe(false);
    });
  });

  describe('cleanup', () => {
    it('fails when an account was not confirmed deleted, and is not asked of a kept run', () => {
      const personas = [persona('cold-start'), persona('deep-reader')];
      const evaluation = evaluateCanary(run(personas, { cleanup: { kept: false, requested: 2, completed: 1 } }));
      expect(evaluation.violations).toEqual([{ code: 'cleanup_incomplete', count: 1 }]);
      expect(codes(run(personas, { cleanup: { kept: true, requested: 0, completed: 0 } }))).toEqual([]);
    });
  });

  it('summarises counts per persona and prints no unit, asset or account', () => {
    const evaluation = evaluateCanary(
      run([
        persona('cold-start', {
          moves: [move('discover', [offer('secret-unit-id')]), move('vertical', [], { outcome: 'pending' })],
          encounters: [encounter('secret-unit-id', { accepted: 5, duplicates: 1 })],
        }),
      ]),
    );
    expect(evaluation.personas[0]).toMatchObject({
      persona: 'cold-start',
      moves: { ready: 1, pending: 1, exhausted: 0 },
      encounters: { scroll: 1, reel: 0, glanced: 0 },
      qualified: 1,
      observations: { accepted: 5, duplicates: 1, rejected: 0 },
    });
    expect(JSON.stringify(evaluation)).not.toContain('secret-unit-id');
  });
});
