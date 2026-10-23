import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { transactionOf, type Database } from '@knowscroll/backend/infrastructure/postgres';
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
 * The daily caps hold under concurrency (review M4). Many proposals race for the last of a cap at
 * the same time, each from its own universe (global and role caps) or from one universe (scope
 * cap), with every model call held in flight so the reservations overlap in time. Exactly the cap
 * is admitted, never more and never fewer.
 *
 * Settlement is gated on every participant reaching transport or completing its refusal, not a
 * wall-clock delay: reported usage legitimately replaces a larger token reservation after a call
 * settles, so a slow admission wave must not race that refund. The global-token case also aligns
 * competing unprotected budget snapshots to make removal of budgetUsage's advisory lock observable
 * as actual over-admission. The scope cases pin the personal root lock's serialization too.
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

  /**
   * Every participant arrives exactly once: at transport, or when its proposal finishes without a
   * call. No fixture answer settles until all admissions have finished. The finally block releases
   * both gates and drains every proposal even if an admission throws or a snapshot assertion fails.
   */
  const race = async (
    participants: readonly FixturePerson[],
    settings: HarnessSettings,
    role: ReasoningRole<unknown> = echoRole,
    options: {
      readonly alignUnprotectedReads?: boolean;
      readonly rejectAdmission?: { readonly universeId: string; readonly error: Error };
    } = {},
  ) => {
    const release = gate<FixtureScenario>();
    const arrived = gate();
    const unprotectedReads = gate();
    const reachedTransport = gate();
    const firstWave = gate();
    const waveSize = Math.min(database.settings.poolMax, participants.length);
    const arrivals = new Set<number>();
    const arrive = (index: number) => {
      arrivals.add(index);
      if (Array.from({ length: waveSize }, (_, index) => index).every((index) => arrivals.has(index))) firstWave.open();
      if (arrivals.size === participants.length) arrived.open();
    };
    const model = fixtureModel(() => ({ kind: 'hold', until: release.promise }));
    const { ports } = fixtureHarness(db(), { model, settings });
    let readers = 0;
    const ledger: typeof ports.ledger = {
      ...ports.ledger,
      async budgetUsage(scope, roleId) {
        if (scope.authority.universeId === options.rejectAdmission?.universeId) {
          await reachedTransport.promise;
          throw options.rejectAdmission.error;
        }
        const usage = await ports.ledger.budgetUsage(scope, roleId);
        if (options.alignUnprotectedReads === true) {
          // This exact bigint key is budgetUsage's shared budget lock, not any advisory lock.
          // A protected snapshot proceeds: waiting for peers here would deadlock them behind
          // its lock. If that lock is removed, align one pool-sized batch of real snapshots
          // before any can reserve. This is a realizable competing-admission schedule, without
          // changing a budget value, reservation, decision or production adapter. The later
          // role-brake lock cannot repair a budget decision made from these stale snapshots.
          const lock = await sql<{ held: boolean }>`
            select exists (select 1 from pg_locks
              where locktype = 'advisory' and pid = pg_backend_pid() and granted
                and mode = 'ExclusiveLock' and classid = 0 and objid = 2231001 and objsubid = 1
            ) as held`.execute(transactionOf(scope));
          if (lock.rows[0]?.held !== true) {
            readers += 1;
            if (readers === waveSize) unprotectedReads.open();
            await unprotectedReads.promise;
          }
        }
        return usage;
      },
    };
    // Each call gets its own wrapper so transport arrival maps to the proposal, even when many
    // participants share one universe. The underlying fixture still records every real send.
    // For snapshot alignment, start one full pool-sized wave first. Once that wave has committed
    // admission and reached transport/refusal, the remaining competitors read its reservations.
    // This keeps a sixth stale snapshot from being refused by the separate five-run role brake
    // after the lock-removal mutation: all excess proposals must exercise the actual spend cap.
    const proposals = participants.map(async (person, index) => {
      if (options.alignUnprotectedReads === true && index >= waveSize) await firstWave.promise;
      const participant = fixtureHarness(db(), {
        model: {
          ...model,
          send: async (...args) => {
            arrive(index);
            reachedTransport.open();
            return model.send(...args);
          },
        },
        settings,
        overrides: { ledger },
      });
      return propose(participant.harness, person, role).finally(() => arrive(index));
    });
    const outcomes = Promise.all(proposals);
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      watchdog = setTimeout(() => reject(new Error('Cap fixture admission did not finish')), 20_000);
    });
    try {
      await Promise.race([arrived.promise, outcomes, deadline]);
      const held = await db()
        .selectFrom('reasoning.usage_receipts as receipt')
        .innerJoin('reasoning.external_attempts as attempt', 'attempt.id', 'receipt.attempt_id')
        .select(['receipt.state', 'receipt.input_tokens', 'receipt.output_tokens', 'attempt.state as attempt_state'])
        .where(
          'attempt.universe_id',
          'in',
          participants.map((person) => person.universeId),
        )
        .execute();
      expect(held).toHaveLength(model.calls.length);
      for (const receipt of held) {
        expect(receipt).toEqual({
          state: 'held',
          input_tokens: null,
          output_tokens: null,
          attempt_state: 'dispatched',
        });
      }
    } finally {
      clearTimeout(watchdog);
      reachedTransport.open();
      firstWave.open();
      unprotectedReads.open();
      release.open({ kind: 'success', text: '{"ok": true, "echo": "lantern"}' });
      await Promise.allSettled(proposals);
    }
    return { outcomes: await outcomes, model };
  };

  it('a global request cap of 5 admits exactly 5 of 16 universes racing', async () => {
    const used = await usedToday();
    const { outcomes, model } = await race(
      await people(16),
      withCaps({ global: { requestsPerDay: used.requests + 5, tokensPerDay: 1_000_000_000 } }),
    );
    expect(tally(outcomes)).toEqual({ proposed: 5, exhausted: 11 });
    expect(model.calls).toHaveLength(5);
  });

  it('a global token cap that fits 3 reservations admits exactly 3 of 12 universes racing', async () => {
    const reserved = await reservation();
    const used = await usedToday();
    const { outcomes, model } = await race(
      await people(12),
      withCaps({ global: { requestsPerDay: 1_000_000, tokensPerDay: used.tokens + reserved * 3 + 10 } }),
      echoRole,
      { alignUnprotectedReads: true },
    );
    expect(tally(outcomes)).toEqual({ proposed: 3, exhausted: 9 });
    expect(model.calls).toHaveLength(3);
  });

  it('a role’s own request and token caps hold across universes racing', async () => {
    const requestLimited: ReasoningRole<unknown> = {
      ...echoRole,
      id: 'fixture.race-requests',
      budget: { requestsPerDay: 4, tokensPerDay: 1_000_000_000 },
    };
    const { outcomes: byRequests, model: requests } = await race(
      await people(12),
      withCaps({ global: unlimited }),
      requestLimited,
    );
    expect(tally(byRequests)).toEqual({ proposed: 4, exhausted: 8 });
    expect(requests.calls).toHaveLength(4);

    const tokenRole: ReasoningRole<unknown> = { ...echoRole, id: 'fixture.race-tokens' };
    // The role's id is part of the request, so the reservation is measured with a role whose id has
    // the same length (the probe's own usage must not count against the role under test).
    const reserved = await reservation({ ...echoRole, id: 'fixture.race-probes' });
    const tokenLimited: ReasoningRole<unknown> = {
      ...tokenRole,
      budget: { requestsPerDay: 1_000_000, tokensPerDay: reserved * 2 + 10 },
    };
    const { outcomes: byTokens, model: tokens } = await race(
      await people(10),
      withCaps({ global: unlimited }),
      tokenLimited,
    );
    expect(tally(byTokens)).toEqual({ proposed: 2, exhausted: 8 });
    expect(tokens.calls).toHaveLength(2);
  });

  it('a per-scope request cap of 3 admits exactly 3 of 10 runs racing in one universe', async () => {
    const person = await seedPerson(db());
    const { outcomes, model } = await race(
      Array.from({ length: 10 }, () => person),
      withCaps({ scope: { requestsPerDay: 3, tokensPerDay: 1_000_000_000 }, global: unlimited }),
    );
    expect(tally(outcomes)).toEqual({ proposed: 3, exhausted: 7 });
    expect(model.calls).toHaveLength(3);
  });

  it('a per-scope token cap that fits 2 reservations admits exactly 2 of 8 runs racing in one universe', async () => {
    const reserved = await reservation();
    const person = await seedPerson(db());
    const { outcomes, model } = await race(
      Array.from({ length: 8 }, () => person),
      withCaps({ scope: { requestsPerDay: 1_000_000, tokensPerDay: reserved * 2 + 10 }, global: unlimited }),
    );
    expect(tally(outcomes)).toEqual({ proposed: 2, exhausted: 6 });
    expect(model.calls).toHaveLength(2);
  });

  it('releases held calls and drains proposals when another admission rejects', async () => {
    const rejecting = await seedPerson(db());
    const admitted = await seedPerson(db());
    const error = new Error('fixture admission rejection');
    await expect(
      race([rejecting, admitted], withCaps({ global: unlimited }), echoRole, {
        rejectAdmission: { universeId: rejecting.universeId, error },
      }),
    ).rejects.toBe(error);
    const attempts = await attemptsOf(db(), admitted.universeId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.state).toBe('succeeded');
    expect(await attemptsOf(db(), rejecting.universeId)).toEqual([]);
  });

  it('charges reported usage after settlement and admits a later reservation that now fits', async () => {
    const reserved = await reservation();
    expect(reserved).toBeGreaterThan(52);
    const used = await usedToday();
    const settings = withCaps({
      global: { requestsPerDay: 1_000_000, tokensPerDay: used.tokens + reserved + 52 },
    });
    const first = await race(await people(2), settings);
    expect(tally(first.outcomes)).toEqual({ proposed: 1, exhausted: 1 });
    expect(first.model.calls).toHaveLength(1);
    expect(await usedToday()).toEqual({ requests: used.requests + 1, tokens: used.tokens + 52 });
    const later = await race(await people(1), settings);
    expect(tally(later.outcomes)).toEqual({ proposed: 1, exhausted: 0 });
    expect(later.model.calls).toHaveLength(1);
    expect(await usedToday()).toEqual({ requests: used.requests + 2, tokens: used.tokens + 104 });
  });
});
