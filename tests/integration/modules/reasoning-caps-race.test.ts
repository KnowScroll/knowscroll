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
  signal,
  systemAuthority,
} from '../support/fixture-model.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';

/**
 * The daily caps hold under concurrency (review M4). Many proposals race for the last of a cap at
 * the same time, each from its own universe (global and role caps) or from one universe (scope
 * cap), with every model call held in flight so the reservations overlap in time. Exactly the cap
 * is admitted, never more and never fewer.
 *
 * Why this fails without the budget advisory lock (`pg_advisory_xact_lock` in `budgetUsage`): two
 * universes' admission transactions do not share a row lock, so each one reads today's spend
 * before the other has inserted its reservation, and both fit. The reviewer's mutation of the
 * shipped code (lock removed, nothing else changed) admitted 5 calls against a global token cap
 * of 3 reservations. The personal root lock serialises one universe's own proposals, which is why
 * the scope case holds without the advisory lock too; it is here to pin that, not to prove the lock.
 *
 * Evidence label: CI fixture + real database.
 */
describe('the daily caps hold under concurrent proposals (real database, fixture model)', () => {
  let database: TestDatabase<Database>;
  beforeAll(async () => {
    database = await createTestDatabase<Database>('caps_race');
  });
  afterAll(async () => {
    await database.drop();
  });
  const db = () => database.db;
  const withCaps = (caps: Partial<HarnessSettings['caps']>): HarnessSettings => ({
    ...fixtureSettings,
    caps: { ...fixtureSettings.caps, ...caps },
  });
  const unlimited = { requestsPerDay: 1_000_000, tokensPerDay: 1_000_000_000 };
  /** Holds every call in flight for a moment, so the proposals overlap. */
  const held = (): FixtureScenario => ({
    kind: 'hold',
    until: new Promise((resolve) =>
      setTimeout(() => resolve({ kind: 'success', text: '{"ok": true, "echo": "lantern"}' }), 200),
    ),
  });
  const propose = (
    harness: ReturnType<typeof fixtureHarness>['harness'],
    person: FixturePerson,
    role: ReasoningRole<unknown> = echoRole,
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
  /** What today's receipts already charge the whole process, so a cap can be set relative to it. */
  const usedToday = async () => {
    const row = (
      await sql<{ requests: number; tokens: string }>`
        select count(*) filter (where state <> 'released')::int as requests,
          coalesce(sum(case
            when state = 'released' then 0
            when input_tokens is not null and output_tokens is not null then input_tokens + output_tokens + coalesce(cached_tokens, 0)
            else reserved_tokens end), 0)::text as tokens
        from reasoning.usage_receipts where budget_window = (now() at time zone 'UTC')::date`.execute(db())
    ).rows[0];
    return { requests: row?.requests ?? 0, tokens: Number(row?.tokens ?? 0) };
  };
  /** The token reservation one proposal of `role` makes (the same bytes give the same reservation). */
  const reservation = async (role: ReasoningRole<unknown> = echoRole) => {
    const probe = await seedPerson(db());
    await propose(fixtureHarness(db(), { model: fixtureModel() }).harness, probe, role);
    return (await attemptsOf(db(), probe.universeId))[0]?.reserved_tokens ?? 0;
  };

  it('a global request cap of 5 admits exactly 5 of 16 universes racing', async () => {
    const used = await usedToday();
    const model = fixtureModel(held);
    const { harness } = fixtureHarness(db(), {
      model,
      settings: withCaps({ global: { requestsPerDay: used.requests + 5, tokensPerDay: 1_000_000_000 } }),
    });
    const outcomes = await Promise.all((await people(16)).map((person) => propose(harness, person)));
    expect(tally(outcomes)).toEqual({ proposed: 5, exhausted: 11 });
    expect(model.calls).toHaveLength(5);
  });

  it('a global token cap that fits 3 reservations admits exactly 3 of 12 universes racing', async () => {
    const reserved = await reservation();
    const used = await usedToday();
    const model = fixtureModel(held);
    const { harness } = fixtureHarness(db(), {
      model,
      settings: withCaps({
        global: { requestsPerDay: 1_000_000, tokensPerDay: used.tokens + reserved * 3 + 10 },
      }),
    });
    const outcomes = await Promise.all((await people(12)).map((person) => propose(harness, person)));
    expect(tally(outcomes)).toEqual({ proposed: 3, exhausted: 9 });
    expect(model.calls).toHaveLength(3);
  });

  it('a role’s own request and token caps hold across universes racing', async () => {
    const requestLimited: ReasoningRole<unknown> = {
      ...echoRole,
      id: 'fixture.race-requests',
      budget: { requestsPerDay: 4, tokensPerDay: 1_000_000_000 },
    };
    const requests = fixtureModel(held);
    const byRequests = await Promise.all(
      (await people(12)).map((person) =>
        propose(
          fixtureHarness(db(), { model: requests, settings: withCaps({ global: unlimited }) }).harness,
          person,
          requestLimited,
        ),
      ),
    );
    expect(tally(byRequests)).toEqual({ proposed: 4, exhausted: 8 });
    expect(requests.calls).toHaveLength(4);

    const tokenRole: ReasoningRole<unknown> = { ...echoRole, id: 'fixture.race-tokens' };
    // The role's id is part of the request, so its reservation is measured with the role itself.
    const reserved = await reservation(tokenRole);
    const tokenLimited: ReasoningRole<unknown> = {
      ...tokenRole,
      budget: { requestsPerDay: 1_000_000, tokensPerDay: reserved * 2 + 10 },
    };
    const tokens = fixtureModel(held);
    const byTokens = await Promise.all(
      (await people(10)).map((person) =>
        propose(
          fixtureHarness(db(), { model: tokens, settings: withCaps({ global: unlimited }) }).harness,
          person,
          tokenLimited,
        ),
      ),
    );
    expect(tally(byTokens)).toEqual({ proposed: 2, exhausted: 8 });
    expect(tokens.calls).toHaveLength(2);
  });

  it('a per-scope request cap of 3 admits exactly 3 of 10 runs racing in one universe', async () => {
    const person = await seedPerson(db());
    const model = fixtureModel(held);
    const { harness } = fixtureHarness(db(), {
      model,
      settings: withCaps({ scope: { requestsPerDay: 3, tokensPerDay: 1_000_000_000 }, global: unlimited }),
    });
    const outcomes = await Promise.all(Array.from({ length: 10 }, () => propose(harness, person)));
    expect(tally(outcomes)).toEqual({ proposed: 3, exhausted: 7 });
    expect(model.calls).toHaveLength(3);
  });

  it('a per-scope token cap that fits 2 reservations admits exactly 2 of 8 runs racing in one universe', async () => {
    const reserved = await reservation();
    const person = await seedPerson(db());
    const model = fixtureModel(held);
    const { harness } = fixtureHarness(db(), {
      model,
      settings: withCaps({ scope: { requestsPerDay: 1_000_000, tokensPerDay: reserved * 2 + 10 }, global: unlimited }),
    });
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => propose(harness, person)));
    expect(tally(outcomes)).toEqual({ proposed: 2, exhausted: 6 });
    expect(model.calls).toHaveLength(2);
  });
});
