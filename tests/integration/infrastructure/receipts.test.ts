import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LockOrderError,
  enterSharedRoot,
  makeWithPersonalScope,
  sharedTransactionOf,
  type Database,
} from '@knowscroll/backend/infrastructure/postgres';
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
import type { SharedScopeTx } from '@knowscroll/backend/modules/identity';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { seedPerson } from '../support/fixtures.js';
import { advisoryRoot } from '../support/shared-root.js';

describe('command receipts (real database)', () => {
  let database: TestDatabase<Database>;
  beforeAll(async () => {
    database = await createTestDatabase<Database>('receipts');
  });
  afterAll(async () => {
    await database.drop();
  });

  const key = (request: Record<string, string | number>) => ({
    commandId: randomUUID(),
    operation: 'experience.apply-action',
    requestHash: requestHash('experience.apply-action', request),
    outcomeVersion: 1,
  });

  it('replays the stored outcome for the same key and request, and refuses a reused key', async () => {
    const person = await seedPerson(database.db);
    const withPersonalScope = makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 });
    const command = key({ kind: 'save' });
    await withPersonalScope(person.authority, async (scope) => {
      expect(await findPersonalReceipt(scope, command)).toEqual({ kind: 'new' });
      await insertPersonalReceipt(scope, command);
      await completePersonalReceipt(scope, command.commandId, { result: 'first' });
    });
    const replay = await withPersonalScope(person.authority, (scope) => findPersonalReceipt(scope, command));
    expect(replay).toEqual({ kind: 'entered', value: { kind: 'replay', outcome: { result: 'first' } } });
    const reused = await withPersonalScope(person.authority, (scope) =>
      findPersonalReceipt(scope, {
        ...command,
        requestHash: requestHash('experience.apply-action', { kind: 'unsave' }),
      }),
    );
    expect(reused).toEqual({ kind: 'entered', value: { kind: 'key_reused' } });
    const otherOperation = await withPersonalScope(person.authority, (scope) =>
      findPersonalReceipt(scope, { ...command, operation: 'experience.other' }),
    );
    expect(otherOperation).toEqual({ kind: 'entered', value: { kind: 'key_reused' } });
  });

  it('never replays a receipt from an earlier privacy epoch, nor an outcome version it cannot read', async () => {
    const person = await seedPerson(database.db);
    const withPersonalScope = makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 });
    const command = key({ kind: 'save' });
    await withPersonalScope(person.authority, async (scope) => {
      await insertPersonalReceipt(scope, command);
      await completePersonalReceipt(scope, command.commandId, { result: 'epoch-1' });
    });
    expect(
      await withPersonalScope(person.authority, (scope) =>
        findPersonalReceipt(scope, { ...command, outcomeVersion: 2 }),
      ),
    ).toEqual({
      kind: 'entered',
      value: { kind: 'outcome_version_unsupported' },
    });
    await database.db
      .updateTable('identity.universes')
      .set({ privacy_epoch: 2 })
      .where('id', '=', person.universeId)
      .execute();
    expect(
      await withPersonalScope({ ...person.authority, privacyEpoch: 2 }, (scope) => findPersonalReceipt(scope, command)),
    ).toEqual({
      kind: 'entered',
      value: { kind: 'epoch_mismatch' },
    });
  });

  it('keeps one universe’s command IDs independent of another’s', async () => {
    const first = await seedPerson(database.db);
    const second = await seedPerson(database.db);
    const withPersonalScope = makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 });
    const command = key({ n: 1 });
    await withPersonalScope(first.authority, async (scope) => {
      await insertPersonalReceipt(scope, command);
      await completePersonalReceipt(scope, command.commandId, { owner: 'first' });
    });
    expect(await withPersonalScope(second.authority, (scope) => findPersonalReceipt(scope, command))).toEqual({
      kind: 'entered',
      value: { kind: 'new' },
    });
  });

  it('rolls the receipt back with the rest of a failed transaction', async () => {
    const person = await seedPerson(database.db);
    const withPersonalScope = makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 });
    const command = key({});
    await expect(
      withPersonalScope(person.authority, async (scope) => {
        await insertPersonalReceipt(scope, command);
        throw new Error('effect failed');
      }),
    ).rejects.toThrow('effect failed');
    expect(await withPersonalScope(person.authority, (scope) => findPersonalReceipt(scope, command))).toEqual({
      kind: 'entered',
      value: { kind: 'new' },
    });
  });

  it('binds shared receipts to actor, scope and operation, inside a shared root locked after the personal root', async () => {
    const actor = await seedPerson(database.db);
    const otherActor = await seedPerson(database.db);
    const withPersonalScope = makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 });
    const conversation = randomUUID();
    const command: SharedCommandKey = {
      actorAccountId: actor.accountId,
      operation: 'social.send-message',
      commandId: randomUUID(),
      requestHash: requestHash('social.send-message', { text: 'fixture' }),
      outcomeVersion: 1,
    };
    const inShared = <T>(
      personAuthority: typeof actor.authority,
      rootId: string,
      work: (shared: SharedScopeTx) => Promise<T>,
    ) =>
      withPersonalScope(personAuthority, async (scope) => {
        const shared = await enterSharedRoot(scope, advisoryRoot('conversation', rootId));
        if (shared === undefined) throw new Error('fixture root missing');
        return work(shared);
      });
    await inShared(actor.authority, conversation, async (shared) => {
      expect(await findSharedReceipt(shared, command)).toEqual({ kind: 'new' });
      await insertSharedReceipt(shared, command);
      await completeSharedReceipt(shared, command, { messageId: 'fixture-message' });
    });
    const results = await inShared(actor.authority, conversation, async (shared) => ({
      replay: await findSharedReceipt(shared, command),
      reused: await findSharedReceipt(shared, {
        ...command,
        requestHash: requestHash('social.send-message', { text: 'other' }),
      }),
      otherOperation: await findSharedReceipt(shared, { ...command, operation: 'social.edit-message' }),
    }));
    expect(results).toEqual({
      kind: 'entered',
      value: {
        replay: { kind: 'replay', outcome: { messageId: 'fixture-message' } },
        reused: { kind: 'key_reused' },
        otherOperation: { kind: 'new' },
      },
    });
    expect(
      await inShared(otherActor.authority, conversation, (shared) =>
        findSharedReceipt(shared, { ...command, actorAccountId: otherActor.accountId }),
      ),
    ).toEqual({
      kind: 'entered',
      value: { kind: 'new' },
    });
    expect(await inShared(actor.authority, randomUUID(), (shared) => findSharedReceipt(shared, command))).toEqual({
      kind: 'entered',
      value: { kind: 'new' },
    });
  });

  it('allows at most one shared root per personal scope, and only while the transaction is open', async () => {
    const person = await seedPerson(database.db);
    const withPersonalScope = makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 });
    let leaked: SharedScopeTx | undefined;
    await expect(
      withPersonalScope(person.authority, async (scope) => {
        leaked = await enterSharedRoot(scope, advisoryRoot('room', randomUUID()));
        await enterSharedRoot(scope, advisoryRoot('room', randomUUID()));
      }),
    ).rejects.toBeInstanceOf(LockOrderError);
    expect(() => sharedTransactionOf(leaked as SharedScopeTx)).toThrow('Shared scope used after its transaction ended');
  });
});
