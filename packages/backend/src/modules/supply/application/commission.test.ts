import { describe, expect, it } from 'vitest';
import type { PersonalScopeTx } from '../../identity/public.js';
import { commissionSupply } from './commission.js';
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
  } = {},
) {
  const events: string[] = [];
  const ports = {
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
