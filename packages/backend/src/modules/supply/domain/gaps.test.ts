import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GAP_POLICY,
  MAX_GAP_ATTEMPTS,
  PIPELINE_LIMIT,
  REOPEN_COOLDOWN_DAYS,
  afterProposal,
  decideGapStep,
  gapIdentity,
  growthRoom,
  isCatalogueTarget,
  mayPropose,
  mayReopen,
  mergeDemand,
  newReadersOf,
  blockedVerdict,
  nextRound,
  priorityOf,
  readerBand,
  reasonCode,
  settleCommissioned,
  structuralGaps,
  type CatalogueTopic,
  type GapCandidate,
  type PlanetFacts,
  type RecipeFact,
} from './gaps.js';

/** Labelled CI fixtures: invented planets and facets, never product data. */
const CATALOGUE: readonly CatalogueTopic[] = [
  { id: 'fixture.tides', facets: ['fixture.tides.pull', 'fixture.tides.range', 'fixture.tides.locking'] },
  { id: 'fixture.stars', facets: ['fixture.stars.light', 'fixture.stars.life'] },
  { id: 'fixture.rocks', facets: [] },
];

const facts = (units: number, facets: Record<string, number> = {}): PlanetFacts => ({
  units,
  facets: new Map(Object.entries(facets)),
});

describe('priority: structural severity first, then a bounded log of readers', () => {
  it('bounds the readers to a band that never reaches the next step of severity', () => {
    expect([0, 1, 3, 7, 15].map(readerBand)).toEqual([0, 1, 2, 3, 4]);
    expect(readerBand(10 ** 12)).toBe(12);
    expect(readerBand(-5)).toBe(0);
    // The most readers on the least severe kind never outrank the least severe step of the next kind up.
    expect(priorityOf(1, 10 ** 12)).toBeLessThan(priorityOf(2, 0));
    expect(priorityOf(5, 10 ** 12)).toBeLessThanOrEqual(1000);
  });

  it('orders more readers above fewer within one severity', () => {
    expect(priorityOf(3, 40)).toBeGreaterThan(priorityOf(3, 2));
    expect(priorityOf(3, 0)).toBe(300);
  });
});

describe('one hole has one identity however it is found', () => {
  it('names the kind, the planet and the facet, and tells them apart', () => {
    expect(gapIdentity('empty_facet', { planet: 'a', facet: 'a.x' })).toBe(
      gapIdentity('empty_facet', { planet: 'a', facet: 'a.x' }),
    );
    expect(gapIdentity('thin_planet', { planet: 'a' })).not.toBe(gapIdentity('shallow_planet', { planet: 'a' }));
    expect(gapIdentity('demand', { planet: 'a' })).not.toBe(gapIdentity('demand', { planet: 'a', facet: 'a.x' }));
    // Neither field can run into the other.
    expect(gapIdentity('demand', { planet: 'a', facet: 'bc' })).not.toBe(
      gapIdentity('demand', { planet: 'ab', facet: 'c' }),
    );
  });

  it('accepts only an exact planet and an exact facet of the catalogue', () => {
    expect(isCatalogueTarget(CATALOGUE, { planet: 'fixture.tides' })).toBe(true);
    expect(isCatalogueTarget(CATALOGUE, { planet: 'fixture.tides', facet: 'fixture.tides.pull' })).toBe(true);
    expect(isCatalogueTarget(CATALOGUE, { planet: 'fixture.tides', facet: 'fixture.stars.light' })).toBe(false);
    expect(isCatalogueTarget(CATALOGUE, { planet: 'fixture' })).toBe(false);
    expect(isCatalogueTarget(CATALOGUE, { planet: 'a tidal wave' })).toBe(false);
  });
});

describe('the structural holes of the library', () => {
  const holes = (map: Record<string, PlanetFacts>, policy = DEFAULT_GAP_POLICY) =>
    structuralGaps(CATALOGUE, new Map(Object.entries(map)), policy).map((gap) => [
      gap.kind,
      gap.planet,
      gap.facet ?? null,
    ]);

  it('calls a planet with fewer than three released explanations thin, and one with nothing the most severe', () => {
    const found = structuralGaps(
      CATALOGUE,
      new Map([['fixture.tides', facts(2, { 'fixture.tides.pull': 1, 'fixture.tides.range': 1 })]]),
      DEFAULT_GAP_POLICY,
    );
    expect(found.find((gap) => gap.planet === 'fixture.tides')).toMatchObject({ kind: 'thin_planet', severity: 4 });
    expect(found.find((gap) => gap.planet === 'fixture.stars')).toMatchObject({ kind: 'thin_planet', severity: 5 });
  });

  it('calls a planet thin when its explanations cover fewer than two facets, however many there are', () => {
    expect(holes({ 'fixture.tides': facts(5, { 'fixture.tides.pull': 5 }) })).toContainEqual([
      'thin_planet',
      'fixture.tides',
      null,
    ]);
    expect(
      holes({ 'fixture.tides': facts(5, { 'fixture.tides.pull': 3, 'fixture.tides.range': 2 }) }),
    ).not.toContainEqual(['thin_planet', 'fixture.tides', null]);
  });

  it('does not ask a planet with a single facet to cover two', () => {
    const single: readonly CatalogueTopic[] = [{ id: 'fixture.one', facets: ['fixture.one.only'] }];
    const found = structuralGaps(single, new Map([['fixture.one', facts(3, { 'fixture.one.only': 3 })]]), {
      ...DEFAULT_GAP_POLICY,
      depthTarget: 3,
    });
    expect(found).toEqual([]);
  });

  it('names every facet with no released Scroll on a planet that is not thin, and not on a thin one', () => {
    const covered = { 'fixture.tides.pull': 2, 'fixture.tides.range': 2 };
    expect(holes({ 'fixture.tides': facts(4, covered) })).toContainEqual([
      'empty_facet',
      'fixture.tides',
      'fixture.tides.locking',
    ]);
    expect(holes({ 'fixture.tides': facts(2, covered) }).filter(([kind]) => kind === 'empty_facet')).toEqual([]);
  });

  it('calls a planet below the depth target shallow once it is not thin and has no empty facet, by the one configured value', () => {
    const all = { 'fixture.tides.pull': 2, 'fixture.tides.range': 2, 'fixture.tides.locking': 2 };
    expect(holes({ 'fixture.tides': facts(6, all) })).not.toContainEqual(['shallow_planet', 'fixture.tides', null]);
    expect(holes({ 'fixture.tides': facts(5, all) })).toContainEqual(['shallow_planet', 'fixture.tides', null]);
    expect(holes({ 'fixture.tides': facts(5, all) }, { ...DEFAULT_GAP_POLICY, depthTarget: 5 })).not.toContainEqual([
      'shallow_planet',
      'fixture.tides',
      null,
    ]);
    // A planet that still has an empty facet is asked about by facet, not as shallow.
    expect(
      holes({ 'fixture.tides': facts(5, { 'fixture.tides.pull': 3, 'fixture.tides.range': 2 }) }),
    ).not.toContainEqual(['shallow_planet', 'fixture.tides', null]);
  });

  it('is deterministic and ordered by planet', () => {
    const a = holes({});
    expect(a).toEqual(holes({}));
    expect(a.map(([, planet]) => planet)).toEqual(['fixture.rocks', 'fixture.stars', 'fixture.tides']);
  });
});

describe('readers join the hole they point to, or open a demand gap of their own', () => {
  const thin: GapCandidate = { kind: 'thin_planet', planet: 'fixture.tides', severity: 4, readers: 0 };
  const empty: GapCandidate = {
    kind: 'empty_facet',
    planet: 'fixture.stars',
    facet: 'fixture.stars.life',
    severity: 3,
    readers: 0,
  };

  it('adds readers to the hole of the same planet and facet, and to the whole planet when the facet has no hole of its own', () => {
    const merged = mergeDemand(
      CATALOGUE,
      [thin, empty],
      [
        { planet: 'fixture.stars', facet: 'fixture.stars.life', readers: 3 },
        { planet: 'fixture.tides', facet: 'fixture.tides.pull', readers: 2 },
        { planet: 'fixture.tides', readers: 4 },
      ],
    );
    expect(merged).toEqual([
      { ...thin, readers: 6 },
      { ...empty, readers: 3 },
    ]);
  });

  it('opens one demand gap for each planet and facet nothing else covers, summing its readers', () => {
    const merged = mergeDemand(
      CATALOGUE,
      [],
      [
        { planet: 'fixture.stars', facet: 'fixture.stars.light', readers: 1 },
        { planet: 'fixture.stars', facet: 'fixture.stars.light', readers: 2 },
        { planet: 'fixture.rocks', readers: 5 },
      ],
    );
    expect(merged).toEqual([
      { kind: 'demand', planet: 'fixture.rocks', severity: 1, readers: 5 },
      { kind: 'demand', planet: 'fixture.stars', facet: 'fixture.stars.light', severity: 1, readers: 3 },
    ]);
  });

  it('drops a signal that names no planet or facet of the catalogue, and one with no reader', () => {
    expect(
      mergeDemand(
        CATALOGUE,
        [],
        [
          { planet: 'a title the model wrote', readers: 9 },
          { planet: 'fixture.tides', facet: 'not.a.facet', readers: 9 },
          { planet: 'fixture.tides', readers: 0 },
        ],
      ),
    ).toEqual([]);
  });

  it('counts only the readers after a day, for the key a rejection ended', () => {
    const days = [
      { planet: 'fixture.tides', day: '2026-11-01', readers: 5 },
      { planet: 'fixture.tides', facet: 'fixture.tides.pull', day: '2026-11-05', readers: 2 },
      { planet: 'fixture.stars', day: '2026-11-05', readers: 9 },
    ];
    expect(newReadersOf(days, { planet: 'fixture.tides' }, '2026-11-01')).toBe(2);
    expect(newReadersOf(days, { planet: 'fixture.tides', facet: 'fixture.tides.locking' }, '2026-10-01')).toBe(0);
    expect(newReadersOf(days, { planet: 'fixture.tides', facet: 'fixture.tides.pull' }, '2026-10-01')).toBe(2);
  });
});

describe('what a gap does next', () => {
  const recipe = (over: Partial<RecipeFact> & { key: string }): RecipeFact => ({
    stored: true,
    facetId: 'fixture.tides.pull',
    state: 'not_started',
    take: 1,
    ...over,
  });

  it('waits while the pipeline already holds enough for it: one recipe for a facet, three for a planet', () => {
    const held = recipe({ key: 'gen-a', state: 'held', take: undefined });
    expect(decideGapStep({ facet: 'fixture.tides.pull' }, [held])).toEqual({ kind: 'wait', recipes: ['gen-a'] });
    // A recipe of another facet does not fill this facet's hole.
    expect(decideGapStep({ facet: 'fixture.tides.range' }, [held])).toEqual({ kind: 'propose' });
    const pipeline = ['a', 'b', 'c', 'd'].map((key) => recipe({ key: `gen-${key}`, state: 'running' }));
    expect(PIPELINE_LIMIT).toBe(3);
    expect(decideGapStep({}, pipeline)).toEqual({ kind: 'wait', recipes: ['gen-a', 'gen-b', 'gen-c'] });
    expect(decideGapStep({}, pipeline.slice(0, 2))).not.toMatchObject({ kind: 'wait' });
  });

  it('commissions a stored recipe that waits to be produced, one for each facet, without asking a model', () => {
    const step = decideGapStep({}, [
      recipe({ key: 'gen-a', facetId: 'f1' }),
      recipe({ key: 'gen-b', facetId: 'f1' }),
      recipe({ key: 'gen-c', facetId: 'f2', state: 'retryable', take: 2 }),
    ]);
    expect(step).toMatchObject({ kind: 'commission' });
    expect(step.kind === 'commission' && step.recipes.map((r) => r.key)).toEqual(['gen-a', 'gen-c']);
  });

  it('leaves a recipe of the library plan to the operator: it neither fills the pipeline nor is commissioned', () => {
    expect(decideGapStep({}, [recipe({ key: 'tides', stored: false })])).toEqual({ kind: 'propose' });
    // A code recipe the operator already produced and holds for a read does fill the pipeline: the hole is on its way.
    const held = recipe({ key: 'tides', stored: false, state: 'held', take: undefined });
    expect(decideGapStep({ facet: 'fixture.tides.pull' }, [held])).toMatchObject({ kind: 'wait' });
  });

  it('does not commission a recipe that cannot start a take, and proposes when nothing is left', () => {
    expect(decideGapStep({}, [recipe({ key: 'gen-a', state: 'stopped', take: undefined })])).toEqual({
      kind: 'propose',
    });
    expect(decideGapStep({}, [])).toEqual({ kind: 'propose' });
  });

  it('commissions no more than the pipeline has room for', () => {
    const running = recipe({ key: 'gen-r', state: 'running' });
    const step = decideGapStep({}, [
      running,
      recipe({ key: 'gen-r2', state: 'held', take: undefined }),
      recipe({ key: 'gen-a', facetId: 'f1' }),
      recipe({ key: 'gen-b', facetId: 'f2' }),
    ]);
    expect(step.kind === 'commission' && step.recipes.map((r) => r.key)).toEqual(['gen-a']);
  });
});

describe('what each outcome of a proposing attempt does to a gap', () => {
  it('briefs the gap with the recipes that were stored', () => {
    expect(afterProposal({ attempts: 0 }, { kind: 'recipes', runId: 'run', keys: ['gen-a', 'gen-b'] })).toEqual({
      kind: 'briefed',
      recipes: ['gen-a', 'gen-b'],
      runId: 'run',
    });
  });

  it('counts a run that stored nothing as a failed attempt, and rejects the gap with the reason on the second', () => {
    const failed = { kind: 'failed', code: 'nothing_accepted' } as const;
    expect(afterProposal({ attempts: 0 }, failed)).toEqual({ kind: 'failed', attempts: 1, reason: 'nothing_accepted' });
    expect(afterProposal({ attempts: MAX_GAP_ATTEMPTS - 1 }, failed)).toEqual({
      kind: 'rejected',
      attempts: MAX_GAP_ATTEMPTS,
      reason: 'nothing_accepted',
    });
    expect(afterProposal({ attempts: 0 }, { kind: 'recipes', keys: [] })).toMatchObject({ kind: 'failed' });
  });

  it('rejects at once for a refusal no retry can change, spending no attempt', () => {
    for (const code of ['topic_unknown', 'facet_unknown', 'no_candidate_pages'] as const)
      expect(afterProposal({ attempts: 1 }, { kind: 'refused', code })).toEqual({ kind: 'refused', reason: code });
  });

  it('keeps the gap as it is when a budget is spent, and blocks it for an attempt of unknown outcome', () => {
    expect(afterProposal({ attempts: 1 }, { kind: 'paused', code: 'budget_exhausted' })).toEqual({
      kind: 'keep',
      reason: 'budget_exhausted',
    });
    expect(afterProposal({ attempts: 0 }, { kind: 'unknown', code: 'Unknown Outcome!' })).toEqual({
      kind: 'blocked',
      reason: 'unknown_outcome',
    });
  });

  it('turns any code into the shape the table checks', () => {
    expect(reasonCode('Budget exhausted: daily')).toBe('budget_exhausted_daily');
    expect(reasonCode('9')).toBe('unknown');
    expect(reasonCode('')).toBe('unknown');
    expect(reasonCode('a'.repeat(100))).toHaveLength(48);
  });
});

describe('a rejected key reopens only when its reason allows and the cooldown has passed', () => {
  const now = new Date('2026-11-20T12:00:00Z');
  const rejected = (reason: string, daysAgo: number) => ({
    reason,
    endedAt: new Date(now.getTime() - daysAgo * 86_400_000),
  });

  it('reopens a model-side failure after the cooldown, with readers since', () => {
    expect(mayReopen(rejected('nothing_accepted', REOPEN_COOLDOWN_DAYS), 1, now)).toBe(true);
    expect(mayReopen(rejected('model_failed', 30), 3, now)).toBe(true);
  });

  it('never reopens a model-side failure without new readers, or inside the cooldown', () => {
    expect(mayReopen(rejected('nothing_accepted', 30), 0, now)).toBe(false);
    expect(mayReopen(rejected('nothing_accepted', 2), 9, now)).toBe(false);
  });

  it('lets a planet that held no page be looked at again after the cooldown with no readers, since a first recipe may have been produced', () => {
    expect(mayReopen(rejected('no_candidate_pages', 30), 0, now)).toBe(true);
    expect(mayReopen(rejected('no_candidate_pages', 2), 9, now)).toBe(false);
  });

  it('never reopens for a name the catalogue lacks, or any reason it does not know', () => {
    for (const reason of ['topic_unknown', 'facet_unknown', 'anything_else'])
      expect(mayReopen(rejected(reason, 60), 9, now)).toBe(false);
  });
});

describe('a commissioned gap settles from where its recipes stand', () => {
  it('closes when one was released, and waits while one is running, held for a read or queued', () => {
    expect(settleCommissioned(['held', 'published'])).toBe('close');
    expect(settleCommissioned(['running'])).toBe('keep');
    expect(settleCommissioned(['held', 'stopped'])).toBe('keep');
    expect(settleCommissioned(['not_started', 'retryable'])).toBe('keep');
    expect(settleCommissioned(['held', 'retryable'])).toBe('keep');
  });

  it('does not treat a rejected take as live: with nothing running, held or released, the gap goes back to briefed for the stored recipe', () => {
    expect(settleCommissioned(['retryable'])).toBe('rebrief');
    expect(settleCommissioned(['retryable', 'stopped'])).toBe('rebrief');
    expect(settleCommissioned(['retryable', undefined])).toBe('rebrief');
  });

  it('goes back to open when every recipe ended for good or is gone from the library', () => {
    expect(settleCommissioned(['stopped', 'stopped'])).toBe('reopen');
    expect(settleCommissioned([undefined, 'stopped'])).toBe('reopen');
    expect(settleCommissioned([])).toBe('reopen');
  });
});

describe('the circuit breaker counts failed production rounds', () => {
  it('counts each round and exhausts the gap at the bound', () => {
    expect(nextRound(0, 3)).toEqual({ rounds: 1, exhausted: false });
    expect(nextRound(1, 3)).toEqual({ rounds: 2, exhausted: false });
    expect(nextRound(2, 3)).toEqual({ rounds: 3, exhausted: true });
    expect(nextRound(0, 1)).toEqual({ rounds: 1, exhausted: true });
  });
});

describe('a blocked gap may be settled only after its attempt is settled in the ledger', () => {
  it('refuses a gap that is not blocked, one that names no run, and one whose run still has an unresolved attempt', () => {
    expect(blockedVerdict({ status: 'open', runId: 'run' }, 0)).toBe('not_blocked');
    expect(blockedVerdict({ status: 'blocked_unknown' }, 0)).toBe('no_run');
    expect(blockedVerdict({ status: 'blocked_unknown', runId: 'run' }, 1)).toBe('unsettled');
    expect(blockedVerdict({ status: 'blocked_unknown', runId: 'run' }, 3)).toBe('unsettled');
  });

  it('is ready once nothing of the run is reserved, dispatched or unknown', () => {
    expect(blockedVerdict({ status: 'blocked_unknown', runId: 'run' }, 0)).toBe('ready');
  });

  it('keeps the run of an unknown attempt on the gap so it can be found, and never lets a reopened gap pass the attempt bound', () => {
    expect(afterProposal({ attempts: 0 }, { kind: 'unknown', code: 'unknown_outcome', runId: 'run-9' })).toEqual({
      kind: 'blocked',
      reason: 'unknown_outcome',
      runId: 'run-9',
    });
    expect(afterProposal({ attempts: 2 }, { kind: 'failed', code: 'model_failed' })).toEqual({
      kind: 'rejected',
      attempts: MAX_GAP_ATTEMPTS,
      reason: 'model_failed',
    });
  });
});

describe('the growth budget', () => {
  it('leaves what the cap allows less the groups already started, never below zero', () => {
    expect(growthRoom(10, 0)).toBe(10);
    expect(growthRoom(10, 7)).toBe(3);
    expect(growthRoom(10, 10)).toBe(0);
    expect(growthRoom(10, 14)).toBe(0);
  });

  it('proposes only while the cap leaves room and the day’s attempts stay under the cap', () => {
    expect(mayPropose(10, 0, 0)).toBe(true);
    expect(mayPropose(10, 10, 0)).toBe(false);
    expect(mayPropose(10, 3, 10)).toBe(false);
    expect(mayPropose(10, 3, 9)).toBe(true);
    expect(mayPropose(0, 0, 0)).toBe(false);
  });
});
