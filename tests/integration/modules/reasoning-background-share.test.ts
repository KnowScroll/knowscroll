import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import type { ReasoningRole } from '@knowscroll/backend/reasoning';
import type { HarnessSettings } from '@knowscroll/backend/reasoning/nest-providers';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { type FixtureScenario } from '../support/fixture-model-port.js';
import {
  attemptsOf,
  echoRole,
  fixtureContext,
  fixtureHarness,
  fixtureModel,
  fixtureRun,
  fixtureSettings,
  gate,
  signal,
  systemAuthority,
} from '../support/fixture-model.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';

/**
 * Background roles (Jev, Cartographer, Planner) stop at their share of the global and the personal
 * daily caps, so a person who only reads or swipes still has the rest for what they ask for (D-058).
 * The share is exact under concurrency because background spend is summed under the same advisory
 * lock as every other budget sum.
 *
 * Evidence label: CI fixture model + real database. Roles here are synthetic copies of the echo role;
 * which real roles are background is asserted in each owning module's tests.
 */
describe('background roles keep to their share of the daily caps (real database, fixture model)', () => {
  let database: TestDatabase<Database>;
  beforeAll(async () => {
    database = await createTestDatabase<Database>('background_share');
  });
  afterAll(async () => {
    await database.drop();
  });
  const db = () => database.db;
  const unlimited = { requestsPerDay: 1_000_000, tokensPerDay: 1_000_000_000 };
  const settingsWith = (caps: Partial<HarnessSettings['caps']>, backgroundSharePercent: number): HarnessSettings => ({
    ...fixtureSettings,
    caps: { global: unlimited, scope: unlimited, roleDefault: unlimited, ...caps },
    backgroundSharePercent,
  });
  /** Several roles of each class, so no role meets its own failure brake while many attempts are in flight. */
  const backgroundRole = (name: string): ReasoningRole<unknown> => ({
    ...echoRole,
    id: `fixture.background-${name}`,
    budgetClass: 'background',
  });
  const askedForRole = (name: string): ReasoningRole<unknown> => ({ ...echoRole, id: `fixture.asked-${name}` });
  const names = ['a', 'b', 'c', 'd'];
  const propose = (
    harness: ReturnType<typeof fixtureHarness>['harness'],
    person: FixturePerson,
    role: ReasoningRole<unknown>,
  ) =>
    harness.propose(
      { run: fixtureRun(systemAuthority(person.universeId), randomUUID()), role, context: fixtureContext },
      signal(),
    );
  const people = (count: number) => Promise.all(Array.from({ length: count }, () => seedPerson(db())));
  const tally = (outcomes: readonly { readonly kind: string }[]) => ({
    proposed: outcomes.filter((outcome) => outcome.kind === 'proposed').length,
    exhausted: outcomes.filter((outcome) => outcome.kind === 'budget_exhausted').length,
  });
  /** Which cap refused an outcome, or its kind when nothing was refused. */
  const exhaustion = (outcome: { readonly kind: string }) => {
    const { dimension = outcome.kind, limit = '' } = outcome as { dimension?: string; limit?: string };
    return { dimension, limit };
  };
  /** The token reservation one proposal makes; the same bytes always reserve the same amount. */
  const reservation = async (role: ReasoningRole<unknown>) => {
    const probe = await seedPerson(db());
    await propose(fixtureHarness(db(), { model: fixtureModel() }).harness, probe, role);
    return (await attemptsOf(db(), probe.universeId))[0]?.reserved_tokens ?? 0;
  };
  /** What today's receipts already charge, in requests: everything, and the background roles' part. */
  const usedToday = async () => {
    const row = (
      await sql<{ requests: string; background: string }>`
        select count(*) filter (where state <> 'released') as requests,
          count(*) filter (where state <> 'released' and background) as background
        from reasoning.usage_receipts where budget_window = (now() at time zone 'UTC')::date`.execute(db())
    ).rows[0];
    return { requests: Number(row?.requests ?? 0), background: Number(row?.background ?? 0) };
  };
  /** The whole percent that gives a cap of `cap` requests a background ceiling of exactly `ceiling` (cap < 100). */
  const shareForCeiling = (cap: number, ceiling: number) => {
    const share = Math.ceil((ceiling * 100) / cap);
    expect(Math.floor((cap * share) / 100)).toBe(ceiling);
    return share;
  };
  const waitUntil = async (condition: () => boolean, what: string) => {
    const deadline = Date.now() + 20_000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  it('records on each receipt whether the role is a background role', async () => {
    const person = await seedPerson(db());
    const { harness } = fixtureHarness(db(), { model: fixtureModel(), settings: settingsWith({}, 50) });
    await propose(harness, person, backgroundRole('receipt'));
    await propose(harness, person, askedForRole('receipt'));
    const attempts = await attemptsOf(db(), person.universeId);
    const receipts = await db()
      .selectFrom('reasoning.usage_receipts')
      .select(['attempt_id', 'background'])
      .where(
        'attempt_id',
        'in',
        attempts.map((attempt) => attempt.id),
      )
      .execute();
    expect(receipts.map((receipt) => receipt.background).sort()).toEqual([false, true]);
  });

  it('stops a background role at its share of one person’s cap and leaves the rest for what they ask', async () => {
    const person = await seedPerson(db());
    const model = fixtureModel();
    const { harness } = fixtureHarness(db(), {
      model,
      settings: settingsWith({ scope: { requestsPerDay: 10, tokensPerDay: 1_000_000_000 } }, 50),
    });
    const background = [];
    for (let index = 0; index < 8; index += 1) background.push(await propose(harness, person, backgroundRole('p')));
    expect(tally(background)).toEqual({ proposed: 5, exhausted: 3 });
    expect(background.slice(5).map(exhaustion)).toEqual(
      Array.from({ length: 3 }, () => ({ dimension: 'background_scope', limit: 'requests' })),
    );
    // What a person asks for still gets the other half of the day…
    const asked = [];
    for (let index = 0; index < 6; index += 1) asked.push(await propose(harness, person, askedForRole('p')));
    expect(tally(asked)).toEqual({ proposed: 5, exhausted: 1 });
    // …and its own cap is the personal one, not the background share.
    expect(exhaustion(asked[5]!)).toEqual({ dimension: 'scope', limit: 'requests' });
    expect(model.calls).toHaveLength(10);
  });

  it('stops background roles at their share of the global cap across people, but not asked-for roles', async () => {
    const [first, second, third, asker] = await people(4);
    const before = await usedToday();
    // Room for 20 more requests today, of which exactly 8 may be background ones.
    const cap = before.requests + 20;
    const settings = settingsWith(
      { global: { requestsPerDay: cap, tokensPerDay: 1_000_000_000 } },
      shareForCeiling(cap, before.background + 8),
    );
    const { harness } = fixtureHarness(db(), { model: fixtureModel(), settings });
    const background = [];
    for (const person of [first!, second!, third!]) {
      for (let index = 0; index < 4; index += 1) background.push(await propose(harness, person, backgroundRole('g')));
    }
    expect(tally(background)).toEqual({ proposed: 8, exhausted: 4 });
    expect(background.filter((outcome) => outcome.kind === 'budget_exhausted').map(exhaustion)).toEqual(
      Array.from({ length: 4 }, () => ({ dimension: 'background_global', limit: 'requests' })),
    );
    // Whoever only asks is untouched by the background roles: all the rest of the cap is theirs.
    const asked = [];
    for (let index = 0; index < 13; index += 1) asked.push(await propose(harness, asker!, askedForRole('g')));
    expect(tally(asked)).toEqual({ proposed: 12, exhausted: 1 });
    expect(exhaustion(asked[12]!)).toEqual({ dimension: 'global', limit: 'requests' });
  });

  it('keeps the same share of the token caps: a background role stops when its tokens are spent', async () => {
    const role = backgroundRole('tokens');
    const reserved = await reservation(role);
    const person = await seedPerson(db());
    // A personal token cap of 20 reservations with 10 percent for background roles: exactly two fit.
    const settings = settingsWith({ scope: { requestsPerDay: 1_000_000, tokensPerDay: reserved * 20 + 5 } }, 10);
    const release = gate<FixtureScenario>();
    const model = fixtureModel(() => ({ kind: 'hold', until: release.promise }));
    const { harness } = fixtureHarness(db(), { model, settings });
    // A reservation stays charged at its full size while its call is in flight.
    const inFlight = [propose(harness, person, role), propose(harness, person, role)];
    await waitUntil(() => model.calls.length === 2, 'two background calls in flight');
    const third = await propose(harness, person, role);
    expect(exhaustion(third)).toEqual({ dimension: 'background_scope', limit: 'tokens' });
    // What the person asks for fits the other 18 reservations while those two are still in flight.
    const asked = propose(harness, person, askedForRole('tokens'));
    await waitUntil(() => model.calls.length === 3, 'the asked-for call in flight');
    release.open({ kind: 'success', text: '{"ok": true, "echo": "lantern"}' });
    expect(tally(await Promise.all([...inFlight, asked]))).toEqual({ proposed: 3, exhausted: 0 });
  });

  it('refuses background roles outright at 0 percent and keeps nothing back at 100 percent', async () => {
    const [off, whole] = await people(2);
    const noBackground = fixtureHarness(db(), {
      model: fixtureModel(),
      settings: settingsWith({ scope: { requestsPerDay: 4, tokensPerDay: 1_000_000_000 } }, 0),
    }).harness;
    // Both ceilings are zero; the wider one is reported first.
    expect(exhaustion(await propose(noBackground, off!, backgroundRole('zero')))).toEqual({
      dimension: 'background_global',
      limit: 'requests',
    });
    expect((await propose(noBackground, off!, askedForRole('zero'))).kind).toBe('proposed');
    expect(await attemptsOf(db(), off!.universeId)).toHaveLength(1);

    const everything = fixtureHarness(db(), {
      model: fixtureModel(),
      settings: settingsWith({ scope: { requestsPerDay: 4, tokensPerDay: 1_000_000_000 } }, 100),
    }).harness;
    const outcomes = [];
    for (let index = 0; index < 5; index += 1) outcomes.push(await propose(everything, whole!, backgroundRole('all')));
    expect(tally(outcomes)).toEqual({ proposed: 4, exhausted: 1 });
    expect(exhaustion(outcomes[4]!)).toEqual({ dimension: 'scope', limit: 'requests' });
  });

  it('is exact under concurrency: of 16 background and 16 asked-for proposals racing, exactly the share and all of the rest are admitted', async () => {
    const release = gate<FixtureScenario>();
    const model = fixtureModel(() => ({ kind: 'hold', until: release.promise }));
    const before = await usedToday();
    // Room for 10 background and 16 asked-for requests and a few spare, so the background share is the
    // only cap that refuses; exactly 10 of them may be background.
    const cap = before.requests + 30;
    const { harness } = fixtureHarness(db(), {
      model,
      settings: settingsWith(
        { global: { requestsPerDay: cap, tokensPerDay: 1_000_000_000 } },
        shareForCeiling(cap, before.background + 10),
      ),
    });
    const background = await people(16);
    const asked = await people(16);
    const settled: string[] = [];
    const track = (label: string, outcome: Promise<{ readonly kind: string }>) =>
      outcome.then((result) => {
        settled.push(`${label}:${result.kind}`);
        return result;
      });
    // Interleave the two kinds so the reservations genuinely overlap in time.
    const proposals = background.flatMap((person, index) => [
      track('background', propose(harness, person, backgroundRole(names[index % names.length]!))),
      track('asked', propose(harness, asked[index]!, askedForRole(names[index % names.length]!))),
    ]);
    try {
      await waitUntil(
        () =>
          model.calls.length === 26 && settled.filter((entry) => entry === 'background:budget_exhausted').length === 6,
        'every admission to finish',
      );
      expect(model.calls).toHaveLength(26);
      expect((await usedToday()).background - before.background).toBe(10);
    } finally {
      release.open({ kind: 'success', text: '{"ok": true, "echo": "lantern"}' });
    }
    const outcomes = await Promise.all(proposals);
    const ofKind = (kind: 'background' | 'asked') =>
      outcomes.filter((_, index) => (index % 2 === 0) === (kind === 'background'));
    expect(tally(ofKind('background'))).toEqual({ proposed: 10, exhausted: 6 });
    expect(tally(ofKind('asked'))).toEqual({ proposed: 16, exhausted: 0 });
    expect(
      ofKind('background')
        .filter((outcome) => outcome.kind === 'budget_exhausted')
        .map(exhaustion),
    ).toEqual(Array.from({ length: 6 }, () => ({ dimension: 'background_global', limit: 'requests' })));
  });
});
