import { describe, expect, it } from 'vitest';
import type { GapRecipe } from '../../content/public.js';
import type { GapStatus, GapTransition, ProposalResult } from '../domain/gaps.js';
import { makeBriefGaps } from './gap-brief.js';
import { commissionGrowth, growthBrief, startOfUtcDay } from './growth.js';
import type { GapBriefPorts, GapRow, GrowthStore, GrowthTx } from './gap-ports.js';
import type { CanonicalBrief } from './ports.js';

/** Labelled CI fixtures: invented planets and recipes, an in-memory store with the one rule of the table, and a fixture proposer. */
const now = new Date('2026-11-11T12:00:00Z');
const stored = (
  key: string,
  facetId: string,
  state: GapRecipe['state'] = 'not_started',
  take: number | undefined = 1,
): GapRecipe => ({
  key,
  stored: true,
  facetId,
  state,
  ...(take === undefined ? {} : { take }),
});

function gapRow(over: Partial<GapRow> & { id: string; planet: string }): GapRow {
  return {
    kind: 'thin_planet',
    status: 'open',
    priority: 500,
    readers: 0,
    attempts: 0,
    rounds: 0,
    recipes: [],
    firstSeenAt: now,
    ...over,
  };
}

function world(options: {
  gaps: GapRow[];
  recipes?: Record<string, GapRecipe[]>;
  proposals?: ProposalResult[];
  cap?: number;
  startedToday?: number;
  attemptedToday?: number;
  enabled?: boolean;
  /** The chooser's answer for each brief. */
  choose?: (brief: {
    topicId: string;
    facetId?: string;
  }) => { kind: 'recipe'; recipe: string; take: number } | { kind: 'none' };
  activeWork?: Record<string, { id: string; recipe?: string }>;
  /** Runs when a proposal is asked for: the recipes it stores appear in the book. */
  onPropose?: () => void;
  /** Another pass holds the lock. */
  busy?: boolean;
}) {
  const events: string[] = [];
  const locks: string[] = [];
  const gaps = options.gaps;
  const proposals = [...(options.proposals ?? [])];
  let started = options.startedToday ?? 0;
  let attempted = options.attemptedToday ?? 0;
  const requests: unknown[] = [];
  const keyOf = (brief: CanonicalBrief) =>
    brief.subject.kind === 'catalogue' ? `${brief.subject.topicId}|${brief.subject.facetId ?? ''}` : '';
  const tx: GrowthTx = {
    countGrowthSince: () => Promise.resolve(started),
    readRecipes: (target) => Promise.resolve(options.recipes?.[target.topicId] ?? []),
    chooseRecipe: (brief) => Promise.resolve(options.choose ? options.choose(brief) : { kind: 'none' as const }),
    findActiveWork: (brief) => Promise.resolve(options.activeWork?.[keyOf(brief)]),
    joinOrCreate: (brief, id, recipe) => {
      events.push(`group ${keyOf(brief)} ${recipe}`);
      started += 1;
      return Promise.resolve({ id, joined: false });
    },
    closeWork: (id) => {
      events.push(`close ${id}`);
      return Promise.resolve();
    },
  };
  const ports: GapBriefPorts = {
    enabled: options.enabled ?? true,
    lock: {
      exclusively: (work) => {
        locks.push('asked');
        return options.busy ? Promise.resolve(undefined) : work();
      },
    },
    growthDailyCap: options.cap ?? 10,
    store: {
      actionable: () => Promise.resolve(gaps.filter((gap) => ['open', 'briefed'].includes(gap.status))),
      commissioned: () => Promise.resolve(gaps.filter((gap) => gap.status === 'commissioned')),
      attemptedSince: () => Promise.resolve(attempted),
      beginAttempt: (id, day) => {
        const gap = gaps.find((g) => g.id === id)!;
        attempted += 1;
        events.push(`begin ${id}`);
        return Promise.resolve(gap.attemptDay ?? day);
      },
      settle: (id, transition: GapTransition) => {
        const gap = gaps.find((g) => g.id === id)!;
        events.push(`settle ${id} ${transition.kind}`);
        const status: Partial<Record<GapTransition['kind'], GapStatus>> = {
          briefed: 'briefed',
          rejected: 'rejected',
          refused: 'rejected',
          blocked: 'blocked_unknown',
        };
        const next = status[transition.kind];
        if (next) gaps[gaps.indexOf(gap)] = { ...gap, status: next };
        if (transition.kind === 'failed') gaps[gaps.indexOf(gap)] = { ...gap, attempts: transition.attempts };
        return Promise.resolve();
      },
      commission: (id, recipes) => {
        const gap = gaps.find((g) => g.id === id)!;
        events.push(`commission ${id} ${recipes.join(',')}`);
        gaps[gaps.indexOf(gap)] = { ...gap, status: 'commissioned', recipes: [...recipes] };
        return Promise.resolve();
      },
    },
    growth: {
      inCommissioning: (work) => work(tx),
      countGrowthSince: () => Promise.resolve(started),
    },
    readGapRecipes: (target) => Promise.resolve(options.recipes?.[target.topicId] ?? []),
    propose: (request) => {
      requests.push(request);
      options.onPropose?.();
      events.push(`propose ${request.topicId} ${request.facetId ?? '-'} retry ${String(request.retry)} ${request.day}`);
      return Promise.resolve(proposals.shift() ?? { kind: 'failed', code: 'nothing_accepted' });
    },
    enqueueProduction: (recipe, take) => {
      events.push(`send ${recipe} ${String(take)}`);
      return Promise.resolve();
    },
    now: () => now,
    newId: () => 'group-id',
  };
  return { locks, ports, run: () => makeBriefGaps(ports)(new AbortController().signal), events, gaps, requests };
}

const chooseFirst = (recipes: Record<string, string>) => (brief: { topicId: string; facetId?: string }) => {
  const key = recipes[`${brief.topicId}|${brief.facetId ?? ''}`];
  return key === undefined ? ({ kind: 'none' } as const) : ({ kind: 'recipe', recipe: key, take: 1 } as const);
};

describe('the brief pass spends nothing it was not allowed to', () => {
  it('does nothing where the loop is off or the growth cap is 0', async () => {
    const off = world({ gaps: [gapRow({ id: 'a', planet: 'p1' })], enabled: false });
    expect(await off.run()).toEqual({ kind: 'disabled' });
    const zero = world({ gaps: [gapRow({ id: 'a', planet: 'p1' })], cap: 0 });
    expect(await zero.run()).toEqual({ kind: 'disabled' });
    expect([...off.events, ...zero.events]).toEqual([]);
  });

  it('runs one pass at a time: it does nothing, and asks no model, while another pass holds the lock', async () => {
    const w = world({
      gaps: [gapRow({ id: 'a', planet: 'p1' })],
      proposals: [{ kind: 'recipes', keys: ['gen-new'] }],
      busy: true,
    });
    expect(await w.run()).toEqual({ kind: 'busy' });
    expect(w.events).toEqual([]);
    const free = world({ gaps: [gapRow({ id: 'a', planet: 'p1' })] });
    expect(await free.run()).toMatchObject({ kind: 'done' });
    expect(free.locks).toEqual(['asked']);
    // A pass that is switched off never takes the lock.
    const off = world({ gaps: [], enabled: false });
    await off.run();
    expect(off.locks).toEqual([]);
  });

  it('commissions a stored recipe whose take was rejected again, under the cap, with no model call', async () => {
    const w = world({
      gaps: [gapRow({ id: 'a', planet: 'p1', status: 'briefed', recipes: ['gen-a'] })],
      recipes: { p1: [stored('gen-a', 'p1.f1', 'retryable', 2)] },
      choose: chooseFirst({ 'p1|p1.f1': 'gen-a' }),
    });
    expect(await w.run()).toMatchObject({ proposed: 0, commissioned: 1 });
    expect(w.events).toEqual(['group p1|p1.f1 gen-a', 'send gen-a 1', 'commission a gen-a']);
    // The cap still decides: with it used up nothing is commissioned and the gap stays briefed.
    const used = world({
      gaps: [gapRow({ id: 'a', planet: 'p1', status: 'briefed', recipes: ['gen-a'] })],
      recipes: { p1: [stored('gen-a', 'p1.f1', 'retryable', 2)] },
      cap: 2,
      startedToday: 2,
      choose: chooseFirst({ 'p1|p1.f1': 'gen-a' }),
    });
    expect(await used.run()).toMatchObject({ proposed: 0, commissioned: 0 });
    expect(used.gaps[0]!.status).toBe('briefed');
  });

  it('notes a hole that is already being filled as commissioned and asks no model', async () => {
    const w = world({
      gaps: [gapRow({ id: 'a', planet: 'p1', facet: 'p1.f', kind: 'empty_facet' })],
      recipes: { p1: [{ key: 'gen-held', stored: true, facetId: 'p1.f', state: 'held' }] },
    });
    expect(await w.run()).toMatchObject({ kind: 'done', waiting: 1, proposed: 0 });
    expect(w.events).toEqual(['commission a gen-held']);
  });

  it('commissions a stored recipe that waits to be produced, with no model call, and sends its job after the group', async () => {
    const w = world({
      gaps: [gapRow({ id: 'a', planet: 'p1' })],
      recipes: { p1: [stored('gen-a', 'p1.f1'), stored('gen-b', 'p1.f2')] },
      choose: chooseFirst({ 'p1|p1.f1': 'gen-a', 'p1|p1.f2': 'gen-b' }),
    });
    expect(await w.run()).toMatchObject({ proposed: 0, commissioned: 2 });
    expect(w.events).toEqual([
      'group p1|p1.f1 gen-a',
      'send gen-a 1',
      'group p1|p1.f2 gen-b',
      'send gen-b 1',
      'commission a gen-a,gen-b',
    ]);
  });

  it('proposes when nothing is in the pipeline, then commissions what was stored under the cap', async () => {
    const recipes: Record<string, GapRecipe[]> = { p1: [] };
    const w = world({
      gaps: [gapRow({ id: 'a', planet: 'p1' })],
      recipes,
      proposals: [{ kind: 'recipes', runId: 'run-1', keys: ['gen-new'] }],
      choose: chooseFirst({ 'p1|p1.f1': 'gen-new' }),
      // The recipes appear in the book once the proposal stored them.
      onPropose: () => {
        recipes['p1'] = [stored('gen-new', 'p1.f1')];
      },
    });
    expect(await w.run()).toMatchObject({ proposed: 1, commissioned: 1 });
    expect(w.events).toEqual([
      'begin a',
      'propose p1 - retry 0 2026-11-11',
      'settle a briefed',
      'group p1|p1.f1 gen-new',
      'send gen-new 1',
      'commission a gen-new',
    ]);
  });
});

describe('cap accounting', () => {
  it('does not propose while the growth cap is used up, and commissions nothing past it', async () => {
    const used = world({ gaps: [gapRow({ id: 'a', planet: 'p1' })], cap: 3, startedToday: 3 });
    expect(await used.run()).toMatchObject({ proposed: 0, commissioned: 0 });
    expect(used.events).toEqual([]);
    const second = world({
      gaps: [gapRow({ id: 'a', planet: 'p1' })],
      recipes: { p1: [stored('gen-a', 'p1.f1'), stored('gen-b', 'p1.f2')] },
      cap: 3,
      startedToday: 2,
      choose: chooseFirst({ 'p1|p1.f1': 'gen-a', 'p1|p1.f2': 'gen-b' }),
    });
    expect(await second.run()).toMatchObject({ commissioned: 1 });
    expect(second.events.filter((event) => event.startsWith('group'))).toEqual(['group p1|p1.f1 gen-a']);
  });

  it('does not propose once the day’s proposing attempts reach the cap, however many gaps are open', async () => {
    const w = world({ gaps: [gapRow({ id: 'a', planet: 'p1' })], cap: 4, startedToday: 0, attemptedToday: 4 });
    expect(await w.run()).toMatchObject({ proposed: 0 });
    expect(w.events).toEqual([]);
  });

  it('works on at most three gaps a pass and at most one for a planet', async () => {
    const w = world({
      gaps: ['a', 'b', 'c', 'd', 'e']
        .map((id) => gapRow({ id, planet: id === 'b' ? 'p1' : `p-${id}` }))
        .concat(gapRow({ id: 'again', planet: 'p1' })),
    });
    const result = await w.run();
    expect(result).toMatchObject({ proposed: 3, failed: 3 });
    const proposed = w.events.filter((event) => event.startsWith('propose')).map((event) => event.split(' ')[1]);
    expect(new Set(proposed).size).toBe(3);
    // The second gap of planet p1 waits for the next pass.
    expect(w.events.filter((event) => event.startsWith('begin'))).not.toContain('begin again');
  });
});

describe('attempts, redelivery and unknown outcomes', () => {
  it('sends the attempt number as the retry and the day the gap pinned, so a redelivery is the same request', async () => {
    const w = world({
      gaps: [gapRow({ id: 'a', planet: 'p1', attempts: 1, attemptDay: '2026-11-10' })],
      proposals: [{ kind: 'failed', code: 'nothing_accepted' }],
    });
    await w.run();
    expect(w.requests).toEqual([{ topicId: 'p1', retry: 1, day: '2026-11-10' }]);
  });

  it('rejects the gap with the reason on the second failed attempt and records the first as failed', async () => {
    const first = world({
      gaps: [gapRow({ id: 'a', planet: 'p1' })],
      proposals: [{ kind: 'failed', code: 'model_failed' }],
    });
    expect(await first.run()).toMatchObject({ failed: 1, rejected: 0 });
    const second = world({
      gaps: [gapRow({ id: 'a', planet: 'p1', attempts: 1 })],
      proposals: [{ kind: 'failed', code: 'model_failed' }],
    });
    expect(await second.run()).toMatchObject({ failed: 0, rejected: 1 });
    expect(second.events).toContain('settle a rejected');
  });

  it('blocks a gap whose attempt is of unknown outcome and never sends it again', async () => {
    const w = world({
      gaps: [gapRow({ id: 'a', planet: 'p1' })],
      proposals: [{ kind: 'unknown', code: 'unknown_outcome', runId: 'run-1' }],
    });
    expect(await w.run()).toMatchObject({ blocked: 1 });
    expect(w.gaps[0]!.status).toBe('blocked_unknown');
    // The next pass does not even look at it.
    await w.run();
    expect(w.events.filter((event) => event.startsWith('propose'))).toHaveLength(1);
  });

  it('stops the pass when a budget is spent, leaves the gap as it is and spends no attempt of it', async () => {
    const w = world({
      gaps: [gapRow({ id: 'a', planet: 'p1' }), gapRow({ id: 'b', planet: 'p2' })],
      proposals: [{ kind: 'paused', code: 'budget_exhausted' }],
    });
    expect(await w.run()).toMatchObject({ proposed: 1, failed: 0, paused: true });
    expect(w.events.filter((event) => event.startsWith('propose'))).toHaveLength(1);
    expect(w.gaps[0]!.status).toBe('open');
  });

  it('rejects at once for a planet that holds no pages, spending nothing: it is not an attempt and does not use the pass up', async () => {
    const w = world({
      gaps: ['a', 'b', 'c', 'd', 'e'].map((id) => gapRow({ id, planet: `p-${id}` })),
      proposals: [
        { kind: 'refused', code: 'no_candidate_pages' },
        { kind: 'refused', code: 'no_candidate_pages' },
        { kind: 'failed', code: 'nothing_accepted' },
        { kind: 'failed', code: 'nothing_accepted' },
        { kind: 'failed', code: 'nothing_accepted' },
      ],
    });
    // Two refusals cost nothing, so the three attempts of the pass are the three that were really asked.
    expect(await w.run()).toMatchObject({ rejected: 2, proposed: 3, failed: 3 });
    expect(w.events.filter((event) => event.startsWith('settle')).slice(0, 2)).toEqual([
      'settle a refused',
      'settle b refused',
    ]);
  });
});

describe('a job lost between the commit and the send resumes', () => {
  it('sends again the production of a commissioned gap’s own stored recipes that have not finished, and nothing else', async () => {
    const w = world({
      gaps: [gapRow({ id: 'a', planet: 'p1', status: 'commissioned', recipes: ['gen-a', 'gen-done', 'code-one'] })],
      recipes: {
        p1: [
          stored('gen-a', 'p1.f1', 'running', 1),
          stored('gen-done', 'p1.f2', 'held', undefined),
          { key: 'code-one', stored: false, facetId: 'p1.f3', state: 'running', take: 2 },
          stored('gen-other', 'p1.f4', 'not_started', 1),
        ],
      },
    });
    await w.run();
    expect(w.events).toEqual(['send gen-a 1']);
  });
});

describe('Create’s decision with no person', () => {
  const target = { topicId: 'p1', facetId: 'p1.f1' };
  it('names the brief a catalogue Scroll in English, with the facet when there is one', () => {
    expect(growthBrief({ topicId: 'p1' })).toMatchObject({
      format: 'scroll',
      language: 'en',
      subject: { topicId: 'p1' },
    });
    expect(growthBrief(target).subject).toMatchObject({ kind: 'catalogue', topicId: 'p1', facetId: 'p1.f1' });
    expect(startOfUtcDay(new Date('2026-11-11T23:59:59Z')).toISOString()).toBe('2026-11-11T00:00:00.000Z');
  });

  it('joins production already under way and sends its job again, and closes a group that ended', async () => {
    const running = world({
      gaps: [],
      recipes: { p1: [stored('gen-a', 'p1.f1', 'running', 1)] },
      activeWork: { 'p1|p1.f1': { id: 'g1', recipe: 'gen-a' } },
    });
    expect(await commissionGrowth(running.ports, target)).toEqual({ kind: 'joined', recipe: 'gen-a', take: 1 });
    const ended = world({
      gaps: [],
      recipes: { p1: [stored('gen-a', 'p1.f1', 'stopped', undefined)] },
      activeWork: { 'p1|p1.f1': { id: 'g1', recipe: 'gen-a' } },
      choose: chooseFirst({ 'p1|p1.f1': 'gen-b' }),
    });
    expect(await commissionGrowth(ended.ports, target)).toEqual({ kind: 'commissioned', recipe: 'gen-b', take: 1 });
    expect(ended.events).toContain('close g1');
  });

  it('refuses when the day’s growth cap is used up, and asks the chooser for stored recipes only', async () => {
    const used = world({ gaps: [], cap: 2, startedToday: 2, choose: chooseFirst({ 'p1|p1.f1': 'gen-a' }) });
    expect(await commissionGrowth(used.ports, target)).toEqual({ kind: 'capped' });
    const asked: unknown[] = [];
    const open = world({ gaps: [], choose: chooseFirst({ 'p1|p1.f1': 'gen-a' }) });
    const asking: GrowthStore = {
      ...open.ports.growth,
      inCommissioning: (work) =>
        open.ports.growth.inCommissioning((tx) =>
          work({
            ...tx,
            chooseRecipe: (brief, options) => (asked.push(options), tx.chooseRecipe(brief, options)),
          }),
        ),
    };
    await commissionGrowth({ ...open.ports, growth: asking }, target);
    expect(asked).toEqual([{ allow: { code: false, generated: true } }]);
  });

  it('commissions nothing where the cap is 0 and says none when no recipe can be made', async () => {
    expect(await commissionGrowth(world({ gaps: [], cap: 0 }).ports, target)).toEqual({ kind: 'capped' });
    expect(await commissionGrowth(world({ gaps: [] }).ports, target)).toEqual({ kind: 'none' });
  });
});
