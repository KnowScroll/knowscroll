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
import { roomScope } from '../support/rooms.js';

/**
 * Ambient roles (a room's residents speaking on their own, D-162) stop at their share of the global daily cap and
 * at the rooms scope's own cap, so what a person asks for on their own scope is never taken. The share is exact
 * under concurrency because ambient spend is summed under the same advisory lock as every other budget sum.
 *
 * Evidence label: CI fixture model + real database. The roles here are synthetic copies of the echo role; that the
 * room residents are ambient is asserted in `rooms-residents.test.ts`.
 */
describe('ambient roles keep to their share of the global cap and the rooms scope (real database, fixture model)', () => {
  let database: TestDatabase<Database>;
  beforeAll(async () => {
    database = await createTestDatabase<Database>('ambient_share');
  });
  afterAll(async () => {
    await database.drop();
  });
  const db = () => database.db;
  const unlimited = { requestsPerDay: 1_000_000, tokensPerDay: 1_000_000_000 };
  const settingsWith = (caps: Partial<HarnessSettings['caps']>, ambientSharePercent: number): HarnessSettings => ({
    ...fixtureSettings,
    caps: { global: unlimited, scope: unlimited, roleDefault: unlimited, ...caps },
    ambientSharePercent,
  });
  /** Several roles of each class, so no role meets its own failure brake while many attempts are in flight. */
  const ambientRole = (name: string): ReasoningRole<unknown> => ({
    ...echoRole,
    id: `fixture.ambient-${name}`,
    budgetClass: 'ambient',
  });
  const askedForRole = (name: string): ReasoningRole<unknown> => ({ ...echoRole, id: `fixture.asked-${name}` });
  const names = ['a', 'b', 'c', 'd'];
  const roomRun = () => ({
    id: randomUUID(),
    authority: { scopeId: 'rooms' as const, generation: 1 },
    ownerModule: 'fixture',
    purpose: 'fixture-ambient',
    policyVersion: 'fixture.v1',
  });
  /** One ambient proposal on the rooms scope, over `settings` and `model`. */
  const speak = (scope: ReturnType<typeof roomScope>, role: ReasoningRole<unknown>) =>
    scope.harness.proposeProduction({ run: roomRun(), role, context: fixtureContext }, signal());
  /** One interactive proposal on a person's own scope. */
  const ask = (
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
  const exhaustion = (outcome: { readonly kind: string }) => {
    const { dimension = outcome.kind, limit = '' } = outcome as { dimension?: string; limit?: string };
    return { dimension, limit };
  };
  /** What today's receipts already charge, in requests: everything, and the ambient roles' part. */
  const usedToday = async () => {
    const row = (
      await sql<{ requests: string; ambient: string }>`
        select count(*) filter (where state <> 'released') as requests,
          count(*) filter (where state <> 'released' and ambient) as ambient
        from reasoning.usage_receipts where budget_window = (now() at time zone 'UTC')::date`.execute(db())
    ).rows[0];
    return { requests: Number(row?.requests ?? 0), ambient: Number(row?.ambient ?? 0) };
  };
  /** The whole percent that gives a cap of `cap` requests an ambient ceiling of exactly `ceiling` (cap < 100). */
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

  it('records on each receipt whether the role is ambient, and never marks it background too', async () => {
    const scope = roomScope(db(), fixtureModel(), settingsWith({}, 50));
    const person = await seedPerson(db());
    await speak(scope, ambientRole('receipt'));
    await ask(fixtureHarness(db(), { model: fixtureModel() }).harness, person, askedForRole('receipt'));
    const receipts = await db()
      .selectFrom('reasoning.usage_receipts')
      .select(['role_id', 'ambient', 'background'])
      .where('role_id', 'in', ['fixture.ambient-receipt', 'fixture.asked-receipt'])
      .orderBy('role_id')
      .execute();
    expect(receipts).toEqual([
      { role_id: 'fixture.ambient-receipt', ambient: true, background: false },
      { role_id: 'fixture.asked-receipt', ambient: false, background: false },
    ]);
  });

  it('admits exactly its share of the global cap, refuses the next as ambient_global, and still admits what a person asks for', async () => {
    const before = await usedToday();
    // Room for 20 more requests today, of which exactly 6 may be ambient ones.
    const cap = before.requests + 20;
    const settings = settingsWith(
      { global: { requestsPerDay: cap, tokensPerDay: 1_000_000_000 } },
      shareForCeiling(cap, before.ambient + 6),
    );
    const scope = roomScope(db(), fixtureModel(), settings);
    const ambient = [];
    for (let index = 0; index < 9; index += 1) ambient.push(await speak(scope, ambientRole(names[index % 4]!)));
    expect(tally(ambient)).toEqual({ proposed: 6, exhausted: 3 });
    expect(ambient.slice(6).map(exhaustion)).toEqual(
      Array.from({ length: 3 }, () => ({ dimension: 'ambient_global', limit: 'requests' })),
    );
    expect((await usedToday()).ambient - before.ambient).toBe(6);
    // A person's ask on their own scope is untouched by the ambient roles: the rest of the cap is theirs, up to the hard cap.
    const person = await seedPerson(db());
    const { harness } = fixtureHarness(db(), { model: fixtureModel(), settings });
    const asked = [];
    for (let index = 0; index < 15; index += 1) asked.push(await ask(harness, person, askedForRole(names[index % 4]!)));
    expect(tally(asked)).toEqual({ proposed: 14, exhausted: 1 });
    expect(exhaustion(asked[14]!)).toEqual({ dimension: 'global', limit: 'requests' });
  });

  it('keeps the same share of the token cap, and stops at the rooms scope’s own cap before the share', async () => {
    const probe = roomScope(db(), fixtureModel(), settingsWith({}, 100));
    await speak(probe, ambientRole('tokens'));
    const reserved = (await attemptsReserved('fixture.ambient-tokens'))[0]!;
    // A global token cap with room for 30 reservations and a share that lets exactly two more ambient ones through while
    // their calls are in flight (a reservation stays charged at its full size until it settles).
    const release = gate<FixtureScenario>();
    const model = fixtureModel(() => ({ kind: 'hold', until: release.promise }));
    const used = await usedTokensToday(false);
    const ambientUsed = await usedTokensToday(true);
    const tokenCap = used + reserved * 30;
    const share = Math.ceil((100 * (ambientUsed + reserved * 2 + 1)) / tokenCap);
    const ceiling = Math.floor((tokenCap * share) / 100);
    expect(ceiling).toBeGreaterThanOrEqual(ambientUsed + reserved * 2);
    expect(ceiling).toBeLessThan(ambientUsed + reserved * 3);
    const scope = roomScope(
      db(),
      model,
      settingsWith({ global: { requestsPerDay: 1_000_000, tokensPerDay: tokenCap } }, share),
    );
    const inFlight = [speak(scope, ambientRole('a')), speak(scope, ambientRole('b'))];
    await waitUntil(() => model.calls.length === 2, 'two ambient calls in flight');
    const third = await speak(scope, ambientRole('c'));
    expect(exhaustion(third)).toEqual({ dimension: 'ambient_global', limit: 'tokens' });
    release.open({ kind: 'success', text: '{"ok": true, "echo": "lantern"}' });
    expect(tally(await Promise.all(inFlight))).toEqual({ proposed: 2, exhausted: 0 });

    // The rooms scope's own cap binds first when it is the smaller: three requests, whatever the share allows.
    const spent = await roomScopeSpent();
    const tight = roomScope(
      db(),
      fixtureModel(),
      settingsWith({ scope: { requestsPerDay: spent + 3, tokensPerDay: 1_000_000_000 } }, 100),
    );
    const outcomes = [];
    for (let index = 0; index < 5; index += 1) outcomes.push(await speak(tight, ambientRole(names[index % 4]!)));
    expect(tally(outcomes)).toEqual({ proposed: 3, exhausted: 2 });
    expect(exhaustion(outcomes[3]!)).toEqual({ dimension: 'scope', limit: 'requests' });
  });

  it('holds an ambient role to the same share whichever ledger it is reserved in', async () => {
    const before = await usedToday();
    const cap = before.requests + 20;
    const settings = settingsWith(
      { global: { requestsPerDay: cap, tokensPerDay: 1_000_000_000 } },
      shareForCeiling(cap, before.ambient + 3),
    );
    const person = await seedPerson(db());
    const { harness } = fixtureHarness(db(), { model: fixtureModel(), settings });
    const outcomes = [];
    for (let index = 0; index < 4; index += 1) outcomes.push(await ask(harness, person, ambientRole(names[index]!)));
    expect(tally(outcomes)).toEqual({ proposed: 3, exhausted: 1 });
    expect(exhaustion(outcomes[3]!)).toEqual({ dimension: 'ambient_global', limit: 'requests' });
  });

  it('refuses ambient roles outright at 0 percent, while a person’s ask is admitted', async () => {
    const off = roomScope(db(), fixtureModel(), settingsWith({}, 0));
    expect(exhaustion(await speak(off, ambientRole('zero')))).toEqual({
      dimension: 'ambient_global',
      limit: 'requests',
    });
    const person = await seedPerson(db());
    const { harness } = fixtureHarness(db(), { model: fixtureModel(), settings: settingsWith({}, 0) });
    expect((await ask(harness, person, askedForRole('zero'))).kind).toBe('proposed');
    expect(await attemptsOf(db(), person.universeId)).toHaveLength(1);
  });

  it('is exact under concurrency: of 16 ambient and 16 asked-for proposals racing, exactly the share and all of the rest are admitted', async () => {
    const release = gate<FixtureScenario>();
    const model = fixtureModel(() => ({ kind: 'hold', until: release.promise }));
    const before = await usedToday();
    // Room for 8 ambient and 16 asked-for requests and a few spare, so the ambient share is the only cap that refuses.
    const cap = before.requests + 30;
    const settings = settingsWith(
      { global: { requestsPerDay: cap, tokensPerDay: 1_000_000_000 } },
      shareForCeiling(cap, before.ambient + 8),
    );
    const scope = roomScope(db(), model, settings);
    const { harness } = fixtureHarness(db(), { model, settings });
    const askers = await people(16);
    const settled: string[] = [];
    const track = (label: string, outcome: Promise<{ readonly kind: string }>) =>
      outcome.then((result) => {
        settled.push(`${label}:${result.kind}`);
        return result;
      });
    // Interleave the two kinds so the reservations genuinely overlap in time.
    const proposals = askers.flatMap((person, index) => [
      track('ambient', speak(scope, ambientRole(names[index % 4]!))),
      track('asked', ask(harness, person, askedForRole(names[index % 4]!))),
    ]);
    try {
      await waitUntil(
        () => model.calls.length === 24 && settled.filter((entry) => entry === 'ambient:budget_exhausted').length === 8,
        'every admission to finish',
      );
      expect(model.calls).toHaveLength(24);
      expect((await usedToday()).ambient - before.ambient).toBe(8);
    } finally {
      release.open({ kind: 'success', text: '{"ok": true, "echo": "lantern"}' });
    }
    const outcomes = await Promise.all(proposals);
    const ofKind = (kind: 'ambient' | 'asked') =>
      outcomes.filter((_, index) => (index % 2 === 0) === (kind === 'ambient'));
    expect(tally(ofKind('ambient'))).toEqual({ proposed: 8, exhausted: 8 });
    expect(tally(ofKind('asked'))).toEqual({ proposed: 16, exhausted: 0 });
    expect(
      ofKind('ambient')
        .filter((outcome) => outcome.kind === 'budget_exhausted')
        .map(exhaustion),
    ).toEqual(Array.from({ length: 8 }, () => ({ dimension: 'ambient_global', limit: 'requests' })));
  });

  /** Reserved tokens of every attempt of a role, oldest first. */
  async function attemptsReserved(roleId: string): Promise<number[]> {
    const rows = await db()
      .selectFrom('reasoning.production_attempts')
      .select('reserved_tokens')
      .where('role_id', '=', roleId)
      .orderBy('reserved_at')
      .execute();
    return rows.map((row) => row.reserved_tokens);
  }
  /** Tokens today's receipts already charge: all of them, or the ambient roles' part. */
  async function usedTokensToday(ambientOnly: boolean): Promise<number> {
    const row = (
      await sql<{ tokens: string }>`
        select coalesce(sum(case when state = 'released' then 0 when input_tokens is not null and output_tokens is not null
          then input_tokens + output_tokens + coalesce(cached_tokens, 0) else reserved_tokens end), 0) as tokens
        from reasoning.usage_receipts
        where budget_window = (now() at time zone 'UTC')::date and (ambient or not ${ambientOnly})`.execute(db())
    ).rows[0];
    return Number(row?.tokens ?? 0);
  }
  /** Requests the rooms scope has spent today. */
  async function roomScopeSpent(): Promise<number> {
    const row = (
      await sql<{ n: string }>`
        select count(*)::text as n from reasoning.production_attempts
        where scope_id = 'rooms' and budget_window = (now() at time zone 'UTC')::date`.execute(db())
    ).rows[0];
    return Number(row?.n ?? 0);
  }
});
