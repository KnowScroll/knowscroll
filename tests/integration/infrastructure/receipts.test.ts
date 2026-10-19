import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import {
  completePersonalReceipt,
  completeSharedReceipt,
  findPersonalReceipt,
  findSharedReceipt,
  insertPersonalReceipt,
  insertSharedReceipt,
  requestHash,
  type SharedCommandKey,
} from '@knowscroll/backend/infrastructure/receipts';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { seedPerson } from '../support/fixtures.js';

describe('command receipts (real database)', () => {
  let database: TestDatabase<Database>;
  beforeAll(async () => {
    database = await createTestDatabase<Database>('receipts');
  });
  afterAll(async () => {
    await database.drop();
  });

  it('replays the stored outcome for the same key and request, and refuses a reused key', async () => {
    const person = await seedPerson(database.db);
    const withPersonalScope = makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 });
    const key = {
      commandId: randomUUID(),
      operation: 'experience.apply-action',
      requestHash: requestHash('experience.apply-action', { kind: 'save' }),
    };
    await withPersonalScope(person.authority, async (scope) => {
      expect(await findPersonalReceipt(scope, key)).toEqual({ kind: 'new' });
      await insertPersonalReceipt(scope, key);
      await completePersonalReceipt(scope, key.commandId, { result: 'first' });
    });
    const replay = await withPersonalScope(person.authority, (scope) => findPersonalReceipt(scope, key));
    expect(replay).toEqual({ kind: 'entered', value: { kind: 'replay', outcome: { result: 'first' } } });
    const reused = await withPersonalScope(person.authority, (scope) =>
      findPersonalReceipt(scope, { ...key, requestHash: requestHash('experience.apply-action', { kind: 'unsave' }) }),
    );
    expect(reused).toEqual({ kind: 'entered', value: { kind: 'key_reused' } });
    const otherOperation = await withPersonalScope(person.authority, (scope) =>
      findPersonalReceipt(scope, { ...key, operation: 'experience.other' }),
    );
    expect(otherOperation).toEqual({ kind: 'entered', value: { kind: 'key_reused' } });
  });

  it('keeps one universe’s command IDs independent of another’s', async () => {
    const first = await seedPerson(database.db);
    const second = await seedPerson(database.db);
    const withPersonalScope = makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 });
    const key = {
      commandId: randomUUID(),
      operation: 'experience.apply-action',
      requestHash: requestHash('experience.apply-action', { n: 1 }),
    };
    await withPersonalScope(first.authority, async (scope) => {
      await insertPersonalReceipt(scope, key);
      await completePersonalReceipt(scope, key.commandId, { owner: 'first' });
    });
    expect(await withPersonalScope(second.authority, (scope) => findPersonalReceipt(scope, key))).toEqual({
      kind: 'entered',
      value: { kind: 'new' },
    });
  });

  it('rolls the receipt back with the rest of a failed transaction', async () => {
    const person = await seedPerson(database.db);
    const withPersonalScope = makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 });
    const key = {
      commandId: randomUUID(),
      operation: 'experience.apply-action',
      requestHash: requestHash('experience.apply-action', {}),
    };
    await expect(
      withPersonalScope(person.authority, async (scope) => {
        await insertPersonalReceipt(scope, key);
        throw new Error('effect failed');
      }),
    ).rejects.toThrow('effect failed');
    expect(await withPersonalScope(person.authority, (scope) => findPersonalReceipt(scope, key))).toEqual({
      kind: 'entered',
      value: { kind: 'new' },
    });
  });

  it('binds shared receipts to actor, scope and operation', async () => {
    const actor = await seedPerson(database.db);
    const otherActor = await seedPerson(database.db);
    const key: SharedCommandKey = {
      scopeKind: 'conversation',
      scopeId: randomUUID(),
      actorAccountId: actor.accountId,
      operation: 'social.send-message',
      commandId: randomUUID(),
      requestHash: requestHash('social.send-message', { text: 'fixture' }),
    };
    await database.db.transaction().execute(async (trx) => {
      expect(await findSharedReceipt(trx, key)).toEqual({ kind: 'new' });
      await insertSharedReceipt(trx, key);
      await completeSharedReceipt(trx, key, { messageId: 'fixture-message' });
    });
    await database.db.transaction().execute(async (trx) => {
      expect(await findSharedReceipt(trx, key)).toEqual({ kind: 'replay', outcome: { messageId: 'fixture-message' } });
      expect(
        await findSharedReceipt(trx, { ...key, requestHash: requestHash('social.send-message', { text: 'other' }) }),
      ).toEqual({ kind: 'key_reused' });
      expect(await findSharedReceipt(trx, { ...key, actorAccountId: otherActor.accountId })).toEqual({ kind: 'new' });
      expect(await findSharedReceipt(trx, { ...key, scopeId: randomUUID() })).toEqual({ kind: 'new' });
      expect(await findSharedReceipt(trx, { ...key, operation: 'social.edit-message' })).toEqual({ kind: 'new' });
    });
  });
});
