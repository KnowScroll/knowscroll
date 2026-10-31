import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  NetworkInTransactionError,
  makeWithPersonalScope,
  withTransaction,
  type Database,
} from '@knowscroll/backend/infrastructure/postgres';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import type { HarnessPorts, ModelPort } from '@knowscroll/backend/reasoning/nest-providers';
import { fixtureHarness, fixtureModel } from '../support/fixture-model.js';
import { fixtureModelPort } from '../support/fixture-model-port.js';
import { fixtureImagePort } from '../support/fixture-image.js';
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

  it('accepts only a guarded model port: an unguarded one is a type error, and a wired one is guarded anyway (review m9)', async () => {
    const unguarded: ModelPort = fixtureModelPort({ label: 'unguarded', script: () => ({ kind: 'malformed' }) });
    // The harness's ports want the branded `GuardedModelPort` that only `guardedModelPort` makes:
    // removing the brand turns the next line into "unused @ts-expect-error", which fails typecheck.
    // @ts-expect-error -- an unguarded model port must not be accepted as a harness port
    const refused: HarnessPorts['model'] = unguarded;
    expect(refused).toBe(unguarded);

    // The composition helper wraps whatever it is given, so a wired harness is guarded regardless.
    const { ports } = fixtureHarness(database.db, { model: unguarded });
    const person = await seedPerson(database.db);
    const withPersonalScope = makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 });
    const wired = ports.model;
    if (wired === undefined) throw new Error('the harness helper wires the model it is given');
    await expect(
      withPersonalScope(person.authority, () => wired.send(new Uint8Array(), new AbortController().signal)),
    ).rejects.toBeInstanceOf(NetworkInTransactionError);
  });

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

  it('refuses an image request inside a transaction (D-166) and allows it outside', async () => {
    const person = await seedPerson(database.db);
    const image = fixtureImagePort();
    const withPersonalScope = makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 });
    await expect(
      withPersonalScope(person.authority, () => image.generate({ prompt: 'x' }, new AbortController().signal)),
    ).rejects.toBeInstanceOf(NetworkInTransactionError);
    await expect(
      withTransaction(database.db, 'ci', () => image.generate({ prompt: 'x' }, new AbortController().signal)),
    ).rejects.toBeInstanceOf(NetworkInTransactionError);
    expect(image.calls).toEqual([]);
    await expect(image.generate({ prompt: 'x' }, new AbortController().signal)).resolves.toMatchObject({
      kind: 'image',
    });
    expect(image.calls).toHaveLength(1);
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
