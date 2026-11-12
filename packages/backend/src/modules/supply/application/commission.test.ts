import { describe, expect, it } from 'vitest';
import type { PersonalScopeTx } from '../../identity/public.js';
import { commissionSupply, isRetryableReason } from './commission.js';
import type { CanonicalBrief, SupplyPorts } from './ports.js';

const scope = {} as PersonalScopeTx;
const brief = (overrides: Partial<CanonicalBrief> = {}): CanonicalBrief => ({
  version: 'supply-brief.v1',
  rights: 'shared_admitted',
  language: 'en',
  format: 'scroll',
  subject: { kind: 'catalogue', catalogueVersion: 'content-concepts.v1', topicId: 'earth.tides' },
  ...overrides,
});

/** In-memory ports for the rules of Create: what it refuses, and the reason it gives for each refusal. */
function world(
  options: {
    cap?: number;
    commissionedToday?: number;
    recipe?: string;
    running?: { recipe: string; state: 'not_started' | 'running' | 'stopped' };
    /** The account is a disposable test account (D-413). */
    disposable?: boolean;
  } = {},
) {
  const events: string[] = [];
  const ports = {
    accountDisposable: () => Promise.resolve(options.disposable === true),
    createDailyCaps: { person: options.cap ?? 5, planner: options.cap ?? 5 },
    now: () => new Date('2026-11-11T10:00:00Z'),
    store: {
      lockCommissioning: () => {
        events.push('lock');
        return Promise.resolve();
      },
      findActiveWork: () =>
        Promise.resolve(options.running ? { id: 'old', recipe: options.running.recipe } : undefined),
      closeWork: () => {
        events.push('close-group');
        return Promise.resolve();
      },
      countCommissionedSince: () => {
        events.push('count');
        return Promise.resolve(options.commissionedToday ?? 0);
      },
      joinOrCreate: (_scope: unknown, _brief: unknown, id: string) => Promise.resolve({ id, joined: false }),
    },
    readProduction: () => Promise.resolve({ state: options.running?.state ?? 'not_started', take: 1 }),
    chooseRecipe: () =>
      Promise.resolve(
        options.recipe === undefined
          ? { kind: 'none' as const }
          : { kind: 'recipe' as const, recipe: options.recipe, take: 1 },
      ),
    enqueueProduction: (_scope: unknown, recipe: string, take: number) => {
      events.push(`send ${recipe} ${String(take)}`);
      return Promise.resolve();
    },
    newId: () => 'new-group',
  } as unknown as SupplyPorts;
  return { ports, events };
}

describe('Create says why it started nothing', () => {
  it('names a Reel, and a variant of an explanation, as having no production path, whatever the cap', async () => {
    for (const cap of [0, 5]) {
      const w = world({ cap, recipe: 'tides' });
      expect(await commissionSupply(w.ports, scope, brief({ format: 'reel' }), 'person')).toEqual({
        kind: 'unavailable',
        reason: 'no_production_path',
        cause: 'no_production_path',
      });
      const variant = brief({
        format: 'reel',
        subject: { kind: 'variant', explanationUnitId: 'unit', source: { assetId: 'asset', assetRevision: 1 } },
      });
      expect(await commissionSupply(w.ports, scope, variant, 'planner')).toMatchObject({
        reason: 'no_production_path',
      });
      expect(w.events).toEqual([]);
    }
  });

  it('tells a cap used up from Create switched off, though a person is told a budget in both', async () => {
    const off = world({ cap: 0, recipe: 'tides' });
    expect(await commissionSupply(off.ports, scope, brief(), 'planner')).toEqual({
      kind: 'unavailable',
      reason: 'budget_unavailable',
      cause: 'create_off',
    });
    // Off needs no count of the day's groups.
    expect(off.events).toEqual(['lock']);
    const used = world({ cap: 2, commissionedToday: 2, recipe: 'tides' });
    expect(await commissionSupply(used.ports, scope, brief(), 'person')).toEqual({
      kind: 'unavailable',
      reason: 'budget_unavailable',
      cause: 'cap_reached',
    });
  });

  it('names a brief with no recipe left as that, not as production that failed', async () => {
    const w = world({ recipe: undefined });
    expect(await commissionSupply(w.ports, scope, brief(), 'person')).toEqual({
      kind: 'unavailable',
      reason: 'no_recipe_left',
      cause: 'no_recipe_left',
    });
    expect(w.events).not.toContain('send tides 1');
  });

  it('commissions the recipe the code chose when nothing stops it, and starts a fresh group when the old one ended', async () => {
    const fresh = world({ recipe: 'tides' });
    expect(await commissionSupply(fresh.ports, scope, brief(), 'planner')).toEqual({
      kind: 'waiting',
      workId: 'new-group',
      decision: 'create',
    });
    expect(fresh.events).toEqual(['lock', 'count', 'send tides 1']);
    const ended = world({ recipe: 'tides', running: { recipe: 'tides', state: 'stopped' } });
    expect(await commissionSupply(ended.ports, scope, brief(), 'planner')).toMatchObject({ decision: 'create' });
    expect(ended.events).toContain('close-group');
  });
});

describe('a disposable test account feeds no shared supply (D-413, D-414)', () => {
  for (const origin of ['person', 'planner'] as const) {
    it(`never starts shared production for ${origin} demand, and says Create is off for it`, async () => {
      const w = world({ recipe: 'tides', disposable: true });
      expect(await commissionSupply(w.ports, scope, brief(), origin)).toEqual({
        kind: 'unavailable',
        reason: 'budget_unavailable',
        cause: 'create_off',
      });
      // Not a lock, a count, a group or a production job: nothing shared was touched.
      expect(w.events).toEqual([]);
    });

    it(`never joins work that is already under way for ${origin} demand`, async () => {
      const w = world({ recipe: 'tides', disposable: true, running: { recipe: 'tides', state: 'running' } });
      expect(await commissionSupply(w.ports, scope, brief(), origin)).toMatchObject({ kind: 'unavailable' });
      expect(w.events).toEqual([]);
    });
  }

  it('leaves no gap signal either, though nothing is left to make', async () => {
    const w = world({ recipe: undefined, disposable: true });
    const recorded: unknown[] = [];
    (w.ports as { recordGapSignals?: (scope: unknown, signals: unknown) => Promise<void> }).recordGapSignals = (
      _scope,
      signals,
    ) => {
      recorded.push(signals);
      return Promise.resolve();
    };
    await commissionSupply(w.ports, scope, brief(), 'person');
    expect(recorded).toEqual([]);
  });

  it('still joins and creates for a real account, so the check is what stops the test account', async () => {
    const created = world({ recipe: 'tides' });
    expect(await commissionSupply(created.ports, scope, brief(), 'planner')).toMatchObject({
      kind: 'waiting',
      decision: 'create',
    });
    expect(created.events).toContain('send tides 1');
    const joined = world({ recipe: 'tides', running: { recipe: 'tides', state: 'running' } });
    expect(await commissionSupply(joined.ports, scope, brief(), 'person')).toMatchObject({
      kind: 'waiting',
      decision: 'join',
    });
  });
});

describe('which closed asks a person may try again', () => {
  it('allows work that was tried and failed, and nothing ready that a release may change, and nothing else', () => {
    expect(isRetryableReason('could_not_prepare')).toBe(true);
    expect(isRetryableReason('no_recipe_left')).toBe(true);
    for (const reason of [
      'no_production_path',
      'budget_unavailable',
      'unsupported_request',
      'no_compatible_supply',
      'not_permitted',
      'source_unavailable',
      undefined,
    ] as const)
      expect(isRetryableReason(reason)).toBe(false);
  });
});

/** The growth cap (D-412): a stored recipe's production counts against its own cap, apart from a person's and the Planner's. */
describe('Create and the growth cap', () => {
  type Choose = SupplyPorts['chooseRecipe'];
  function growthWorld(options: {
    cap?: number;
    growthCap?: number;
    commissionedToday?: number;
    growthToday?: number;
    choose: Choose;
  }) {
    const asked: unknown[] = [];
    const counted: string[] = [];
    const ports = {
      accountDisposable: () => Promise.resolve(false),
      createDailyCaps: { person: options.cap ?? 5, planner: options.cap ?? 5 },
      growthDailyCap: options.growthCap ?? 10,
      now: () => new Date('2026-11-11T10:00:00Z'),
      store: {
        lockCommissioning: () => Promise.resolve(),
        findActiveWork: () => Promise.resolve(undefined),
        closeWork: () => Promise.resolve(),
        countCommissionedSince: (_scope: unknown, _since: Date, origin: string) => {
          counted.push(`origin:${origin}`);
          return Promise.resolve(options.commissionedToday ?? 0);
        },
        countGrowthSince: () => {
          counted.push('growth');
          return Promise.resolve(options.growthToday ?? 0);
        },
        joinOrCreate: (_scope: unknown, _brief: unknown, id: string) => Promise.resolve({ id, joined: false }),
      },
      readProduction: () => Promise.resolve({ state: 'not_started', take: 1 }),
      chooseRecipe: (...args: Parameters<Choose>) => {
        asked.push(args[2]);
        return options.choose(...args);
      },
      enqueueProduction: () => Promise.resolve(),
      newId: () => 'new-group',
    } as unknown as SupplyPorts;
    return { ports, asked, counted };
  }
  const stored = { kind: 'recipe' as const, recipe: 'gen-heart-valves-1a2b3c4d' as const, take: 1 };

  it('lets a stored recipe be chosen when the person cap is used up and growth is open, and says what each kind may use', async () => {
    const w = growthWorld({ cap: 2, commissionedToday: 2, growthToday: 3, choose: () => Promise.resolve(stored) });
    expect(await commissionSupply(w.ports, scope, brief(), 'person')).toMatchObject({
      kind: 'waiting',
      decision: 'create',
    });
    expect(w.asked).toEqual([{ allow: { code: false, generated: true } }]);
  });

  it('keeps growth out of the cap of whoever asked: a full growth cap leaves a code recipe open', async () => {
    const w = growthWorld({
      growthCap: 10,
      growthToday: 10,
      commissionedToday: 1,
      choose: () => Promise.resolve({ kind: 'recipe' as const, recipe: 'tides' as const, take: 1 }),
    });
    expect(await commissionSupply(w.ports, scope, brief(), 'planner')).toMatchObject({ kind: 'waiting' });
    expect(w.asked).toEqual([{ allow: { code: true, generated: false } }]);
  });

  it('refuses, naming the cap, when both caps are used and never asks the chooser', async () => {
    const w = growthWorld({
      cap: 2,
      commissionedToday: 2,
      growthCap: 4,
      growthToday: 4,
      choose: () => Promise.resolve(stored),
    });
    expect(await commissionSupply(w.ports, scope, brief(), 'person')).toEqual({
      kind: 'unavailable',
      reason: 'budget_unavailable',
      cause: 'cap_reached',
    });
    expect(w.asked).toEqual([]);
  });

  it('counts growth apart from the origin: the origin count excludes it and growth is counted for everyone', async () => {
    const w = growthWorld({ choose: () => Promise.resolve(stored) });
    await commissionSupply(w.ports, scope, brief(), 'planner');
    expect(w.counted).toEqual(['origin:planner', 'growth']);
  });

  it('never opens growth when it is set to 0 or when Create is switched off', async () => {
    const zero = growthWorld({ growthCap: 0, choose: () => Promise.resolve({ kind: 'none' }) });
    expect(await commissionSupply(zero.ports, scope, brief(), 'person')).toMatchObject({ cause: 'no_recipe_left' });
    expect(zero.asked).toEqual([{ allow: { code: true, generated: false } }]);
    expect(zero.counted).toEqual(['origin:person']);
    const off = growthWorld({ cap: 0, growthCap: 10, choose: () => Promise.resolve(stored) });
    expect(await commissionSupply(off.ports, scope, brief(), 'person')).toMatchObject({ cause: 'create_off' });
    expect(off.asked).toEqual([]);
    expect(off.counted).toEqual([]);
  });

  it('says cap_reached, not no_recipe_left, when a recipe existed that the cap held back', async () => {
    const held = growthWorld({ choose: () => Promise.resolve({ kind: 'none', capped: true }) });
    expect(await commissionSupply(held.ports, scope, brief(), 'person')).toMatchObject({ cause: 'cap_reached' });
    const noneLeft = growthWorld({ choose: () => Promise.resolve({ kind: 'none' }) });
    expect(await commissionSupply(noneLeft.ports, scope, brief(), 'person')).toMatchObject({ cause: 'no_recipe_left' });
    // With the person's own cap used up, a chooser that finds nothing open leaves the cap as the reason.
    const closed = growthWorld({
      cap: 1,
      commissionedToday: 1,
      growthToday: 0,
      choose: () => Promise.resolve({ kind: 'none' }),
    });
    expect(await commissionSupply(closed.ports, scope, brief(), 'person')).toMatchObject({ cause: 'cap_reached' });
  });

  it('passes the unit a Planner opportunity aimed at to the chooser, and nothing else of it', async () => {
    const w = growthWorld({ choose: () => Promise.resolve(stored) });
    await commissionSupply(w.ports, scope, brief(), 'planner', 'history-industrial-revolution-causes-v1');
    expect(w.asked).toEqual([
      { allow: { code: true, generated: true }, plannedUnit: 'history-industrial-revolution-causes-v1' },
    ]);
  });
});

/** The gap loop's signal (#674, D-414): content that has nothing left to make is counted, and only that. */
describe('Create notes where nothing is left to make, as a count and never the ask', () => {
  type Signals = NonNullable<SupplyPorts['recordGapSignals']>;
  function signalling(options: Parameters<typeof world>[0] & { facetId?: string }) {
    const w = world(options);
    const recorded: Parameters<Signals>[1][] = [];
    (w.ports as { recordGapSignals?: Signals }).recordGapSignals = (_scope, signals) => {
      recorded.push(signals);
      return Promise.resolve();
    };
    return { ...w, recorded };
  }
  const facetBrief = brief({
    subject: {
      kind: 'catalogue',
      catalogueVersion: 'content-concepts.v1',
      topicId: 'earth.tides',
      facetId: 'earth.tides.pull',
    },
  });

  it('records the planet for a person’s ask and for the Planner’s demand, with its facet when the brief has one', async () => {
    const person = signalling({ recipe: undefined });
    await commissionSupply(person.ports, scope, brief(), 'person');
    expect(person.recorded).toEqual([[{ source: 'ask', planet: 'earth.tides' }]]);
    const planner = signalling({ recipe: undefined });
    await commissionSupply(planner.ports, scope, facetBrief, 'planner');
    expect(planner.recorded).toEqual([
      [{ source: 'planned_demand', planet: 'earth.tides', facet: 'earth.tides.pull' }],
    ]);
  });

  it('records nothing when something was commissioned, or when a cap, Create switched off or a Reel stopped it', async () => {
    const commissioned = signalling({ recipe: 'tides' });
    await commissionSupply(commissioned.ports, scope, brief(), 'person');
    const capped = signalling({ cap: 1, commissionedToday: 1, recipe: 'tides' });
    await commissionSupply(capped.ports, scope, brief(), 'person');
    const off = signalling({ cap: 0, recipe: 'tides' });
    await commissionSupply(off.ports, scope, brief(), 'planner');
    const reel = signalling({ recipe: undefined });
    await commissionSupply(reel.ports, scope, brief({ format: 'reel' }), 'person');
    expect([commissioned, capped, off, reel].flatMap((w) => w.recorded)).toEqual([]);
  });

  it('carries only a catalogue planet and facet: the signal has no room for words', async () => {
    const w = signalling({ recipe: undefined });
    await commissionSupply(w.ports, scope, facetBrief, 'person');
    const [signal] = w.recorded[0]!;
    expect(Object.keys(signal!).sort()).toEqual(['facet', 'planet', 'source']);
  });

  it('still refuses honestly where no recorder is composed', async () => {
    const w = world({ recipe: undefined });
    expect(await commissionSupply(w.ports, scope, brief(), 'person')).toMatchObject({ cause: 'no_recipe_left' });
  });
});
