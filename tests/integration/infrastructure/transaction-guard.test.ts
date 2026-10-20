import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  NetworkInTransactionError,
  makeWithPersonalScope,
  type Database,
} from '@knowscroll/backend/infrastructure/postgres';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { fixtureModel } from '../support/fixture-model.js';
import { seedPerson } from '../support/fixtures.js';

describe('the transaction network guard (real database)', () => {
  let database: TestDatabase<Database>;
  beforeAll(async () => {
    database = await createTestDatabase<Database>('tx_guard');
  });
  afterAll(async () => {
    await database.drop();
  });

  const request = { system: 'guard', user: 'x', maxOutputTokens: 16 };

  it('refuses a model call or quota preflight inside a personal transaction and allows them outside', async () => {
    const person = await seedPerson(database.db);
    const model = fixtureModel();
    const body = model.encode(request);
    const withPersonalScope = makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 });
    await expect(
      withPersonalScope(person.authority, () => model.send(body, new AbortController().signal)),
    ).rejects.toBeInstanceOf(NetworkInTransactionError);
    await expect(
      withPersonalScope(person.authority, () => model.observeQuota(new AbortController().signal)),
    ).rejects.toBeInstanceOf(NetworkInTransactionError);
    expect(model.calls).toEqual([]);
    expect(model.quotaChecks()).toBe(0);
    await expect(model.send(body, new AbortController().signal)).resolves.toMatchObject({
      answer: { kind: 'text', text: '{"ok": true, "echo": "lantern"}' },
    });
    expect(model.calls).toHaveLength(1);
  });

  it('keeps the marker across awaits inside the transaction', async () => {
    const person = await seedPerson(database.db);
    const model = fixtureModel();
    const withPersonalScope = makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 });
    await expect(
      withPersonalScope(person.authority, async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        await Promise.resolve();
        return model.send(model.encode(request), new AbortController().signal);
      }),
    ).rejects.toBeInstanceOf(NetworkInTransactionError);
  });
});
