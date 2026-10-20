import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { personalStores } from '@knowscroll/backend/erasure-registry';
import { eraseUniverse } from '@knowscroll/backend/infrastructure/erasure';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { composeEncounter } from '@knowscroll/backend/modules/composer';
import { makeComposerStore } from '@knowscroll/backend/modules/composer/nest-providers';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { seedPerson } from '../support/fixtures.js';
import { fixtureComposerSnapshot } from '../support/composer.js';
describe('Composer private decision ports (real PostgreSQL, CI fixture inputs)', () => {
  let database: TestDatabase<Database>;
  beforeAll(async () => {
    database = await createTestDatabase<Database>('composer');
  });
  afterAll(async () => {
    await database.drop();
  });
  it('persists immutable replay once, authorizes own operator reads, rejects modified/cross-scope decisions', async () => {
    const owner = await seedPerson(database.db);
    const foreign = await seedPerson(database.db);
    const withScope = makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 });
    const store = makeComposerStore({
      isOperator: (a) => a.actor.kind === 'account' && a.actor.accountId === owner.accountId,
    });
    const binding = { decisionId: randomUUID(), commandId: randomUUID(), sessionId: randomUUID(), intentRevision: 0 };
    const decision = composeEncounter(fixtureComposerSnapshot(owner.authority));
    expect(await withScope(owner.authority, (s) => store.persistComposerDecision(s, binding, decision))).toMatchObject({
      kind: 'entered',
      value: 'stored',
    });
    expect(await withScope(owner.authority, (s) => store.persistComposerDecision(s, binding, decision))).toMatchObject({
      kind: 'entered',
      value: 'replayed',
    });
    const read = await withScope(owner.authority, (s) => store.readComposerDecision(s, binding.decisionId));
    expect(read.kind === 'entered' && read.value?.decision).toEqual(decision);
    await expect(
      withScope(foreign.authority, (s) => store.persistComposerDecision(s, binding, decision)),
    ).rejects.toThrow('COMPOSER_SCOPE_MISMATCH');
    await expect(
      withScope(foreign.authority, (s) => store.readComposerDecision(s, binding.decisionId)),
    ).rejects.toThrow('COMPOSER_OPERATOR_REQUIRED');
    const otherOperator = makeComposerStore({ isOperator: () => true });
    expect(
      await withScope(foreign.authority, (s) => otherOperator.readComposerDecision(s, binding.decisionId)),
    ).toMatchObject({ kind: 'entered', value: undefined });
    await expect(
      withScope(owner.authority, (s) => store.persistComposerDecision(s, binding, { ...decision, seed: 'changed' })),
    ).rejects.toThrow('COMPOSER_REPLAY_INVALID');
    await expect(
      sql`update composer.decisions set input_sha256=${'b'.repeat(64)} where id=${binding.decisionId}::uuid`.execute(
        database.db,
      ),
    ).rejects.toThrow('COMPOSER_DECISION_IMMUTABLE');
    const changed = composeEncounter({ ...decision.input, seed: 'new-input' });
    await expect(withScope(owner.authority, (s) => store.persistComposerDecision(s, binding, changed))).rejects.toThrow(
      'COMPOSER_DECISION_CONFLICT',
    );
    await expect(
      withScope(foreign.authority, (s) =>
        store.persistComposerDecision(s, binding, composeEncounter(fixtureComposerSnapshot(foreign.authority))),
      ),
    ).rejects.toThrow('COMPOSER_DECISION_CONFLICT');
    await expect(
      withScope(owner.authority, (s) =>
        store.persistComposerDecision(s, { ...binding, decisionId: randomUUID() }, decision),
      ),
    ).rejects.toThrow('COMPOSER_DECISION_CONFLICT');
  });
  it('rolls back atomically and fences stale epochs before writes; a closed capability cannot be reused', async () => {
    const person = await seedPerson(database.db);
    const withScope = makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 });
    const store = makeComposerStore({ isOperator: () => true });
    const binding = { decisionId: randomUUID(), commandId: randomUUID() };
    const decision = composeEncounter(fixtureComposerSnapshot(person.authority));
    await expect(
      withScope(person.authority, async (s) => {
        await store.persistComposerDecision(s, binding, decision);
        throw new Error('fixture rollback');
      }),
    ).rejects.toThrow('fixture rollback');
    expect(
      (await sql`select id from composer.decisions where id=${binding.decisionId}::uuid`.execute(database.db)).rows,
    ).toHaveLength(0);
    await database.db
      .updateTable('identity.universes')
      .set({ privacy_epoch: 2 })
      .where('id', '=', person.universeId)
      .execute();
    expect(await withScope(person.authority, (s) => store.persistComposerDecision(s, binding, decision))).toMatchObject(
      { kind: 'refused', refusal: { kind: 'epoch_changed' } },
    );
    const fresh = { ...person.authority, privacyEpoch: 2 };
    await expect(withScope(fresh, (s) => store.persistComposerDecision(s, binding, decision))).rejects.toThrow(
      'COMPOSER_SCOPE_MISMATCH',
    );
    const scope = await withScope(fresh, (s) => Promise.resolve(s));
    if (scope.kind !== 'entered') throw new Error('fixture scope');
    await expect(store.readComposerDecision(scope.value, binding.decisionId)).rejects.toThrow(
      'Personal scope used after',
    );
  });
  it('logical expiry refuses reads; bounded pruning and full erasure remove only own private data', async () => {
    const a = await seedPerson(database.db);
    const b = await seedPerson(database.db);
    const withScope = makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 });
    const store = makeComposerStore({ isOperator: () => true });
    const ids: string[] = [];
    for (const person of [a, b])
      for (let n = 0; n < 2; n++) {
        const id = randomUUID();
        ids.push(id);
        await withScope(person.authority, (s) =>
          store.persistComposerDecision(
            s,
            { decisionId: id, commandId: randomUUID() },
            composeEncounter(fixtureComposerSnapshot(person.authority)),
          ),
        );
      }
    await sql`update composer.decisions set recorded_at=now()-interval '31 days',expires_at=now()-interval '1 day' where universe_id=${a.universeId}::uuid`.execute(
      database.db,
    );
    expect(await withScope(a.authority, (s) => store.readComposerDecision(s, ids[0]!))).toMatchObject({
      kind: 'entered',
      value: undefined,
    });
    expect(await withScope(a.authority, (s) => store.pruneComposerDecisions(s, 1))).toMatchObject({
      kind: 'entered',
      value: 1,
    });
    await withScope(a.authority, (s) => eraseUniverse(s, personalStores));
    expect(
      (await sql`select id from composer.decisions where universe_id=${a.universeId}::uuid`.execute(database.db)).rows,
    ).toHaveLength(0);
    expect(
      (await sql`select id from composer.decisions where universe_id=${b.universeId}::uuid`.execute(database.db)).rows,
    ).toHaveLength(2);
  });
});
