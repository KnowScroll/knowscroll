/**
 * `composer replay-policy` over decisions that are really stored (v3 S-5, D-190): the store pages through the retained
 * vertical decisions without skipping or repeating one, even when many share a microsecond, and the report that comes
 * out of the replay holds counts and shares only. Labelled CI fixtures, composed under policy v0 as the stored ones are.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import {
  COMPOSER_POLICY_V0,
  composeEncounter,
  DEFAULT_VARIANTS,
  startPolicyReplay,
} from '@knowscroll/backend/modules/composer';
import { readRetainedDecisions } from '@knowscroll/backend/modules/composer/nest-providers';
import { fixtureSnapshots } from '../../../packages/backend/src/modules/composer/application/snapshot-fixtures.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';

describe('composer replay-policy over stored decisions (real PostgreSQL, labelled CI fixtures)', () => {
  let database: TestDatabase<Database>;
  let person: FixturePerson;
  const base = new Date('2026-10-25T12:00:00.000Z');
  const seeds = new Set<string>();

  async function store(index: number, snapshot: ReturnType<typeof fixtureSnapshots>[number], recordedAt: string) {
    const seed = `replay-${String(index)}`;
    const made = composeEncounter(
      {
        ...snapshot,
        universeId: person.universeId,
        seed,
        ...(snapshot.evidence ? { evidence: { ...snapshot.evidence, universeId: person.universeId } } : {}),
      },
      COMPOSER_POLICY_V0,
    );
    await sql`insert into composer.decisions (id, universe_id, privacy_epoch, command_id, input_sha256, policy_version, payload, recorded_at, expires_at)
      values (${randomUUID()}::uuid, ${person.universeId}::uuid, 1, ${randomUUID()}::uuid, ${'b'.repeat(64)}, ${made.policyVersion},
        ${JSON.stringify(made)}::jsonb, ${recordedAt}::timestamptz, ${recordedAt}::timestamptz + interval '1 day')`.execute(
      database.db,
    );
    return made;
  }

  beforeAll(async () => {
    database = await createTestDatabase<Database>('composer_replay');
    person = await seedPerson(database.db);
    const snapshots = fixtureSnapshots();
    let index = 0;
    // 90 stored decisions, in three groups that share one microsecond each, so only the id tells them apart.
    for (const microsecond of [100, 200, 300])
      for (let n = 0; n < 30; n += 1) {
        const snapshot = snapshots.filter((s) => s.mode === 'vertical')[n % 30]!;
        const made = await store(index, snapshot, `2026-10-30 10:00:00.${String(microsecond).padStart(6, '0')}+00`);
        seeds.add(made.seed);
        index += 1;
      }
    // Older than the window, and not vertical: neither is read.
    await store(index, snapshots.filter((s) => s.mode === 'vertical')[0]!, '2026-10-01 10:00:00+00');
    await store(
      index + 1,
      snapshots.find((s) => s.mode === 'horizontal')!,
      '2026-10-30 11:00:00+00',
    );
  });
  afterAll(async () => {
    await database.drop();
  });

  const read = async (limit: number, since = base) => {
    const found: string[] = [];
    for await (const stored of readRetainedDecisions(database.db, { since, limit }))
      found.push((stored.payload as { seed: string }).seed);
    return found;
  };

  it('reads every retained vertical decision of the window once, newest first, across pages', async () => {
    const found = await read(1000);
    expect(found).toHaveLength(90);
    expect(new Set(found)).toEqual(seeds);
    // The newest microsecond first.
    expect(found.slice(0, 30).every((seed) => Number(seed.split('-')[1]) >= 60)).toBe(true);
  });

  it('stops at the limit, at a page boundary or not, without a repeat', async () => {
    for (const limit of [1, 39, 40, 41, 80, 89]) {
      const found = await read(limit);
      expect(found).toHaveLength(limit);
      expect(new Set(found).size).toBe(limit);
    }
  });

  it('reads nothing from before the date asked for', async () => {
    expect(await read(1000, new Date('2026-10-30T10:00:01Z'))).toEqual([]);
    // Before October the one older vertical decision is read too.
    expect(await read(1000, new Date('2026-09-01T00:00:00Z'))).toHaveLength(91);
  });

  it('feeds the replay, whose report names nobody and nothing', async () => {
    const replay = startPolicyReplay(DEFAULT_VARIANTS);
    for await (const stored of readRetainedDecisions(database.db, { since: base, limit: 1000 })) replay.add(stored);
    const report = replay.report();
    expect(report).toMatchObject({ read: 90, storedPolicies: { 'composer-policy.v0': 90 } });
    expect(report.replayed).toBeGreaterThan(0);
    const text = JSON.stringify(report);
    expect(text).not.toContain(person.universeId);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    expect(text).not.toMatch(/asset-|Fixture|replay-/);
  });
});
