import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { accountAccessUseCases } from '@knowscroll/backend/modules/identity/nest-providers';
import {
  lockKeepPositionTarget,
  readScrollAskFacts,
  validateSnippetAnchor,
} from '@knowscroll/backend/modules/content/nest-providers';
import { momentAnchorOf, momentOf } from '@knowscroll/scroll-model';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { recordingPerson } from '../support/recording-person.js';
import { scrollUseCases } from '../support/scroll.js';
import { seedDocumentV2, v2Client } from '../support/scroll-v3.js';

type Cases = Awaited<ReturnType<typeof scrollUseCases>>;

/**
 * A stored v2 Scroll whose stage is Earth & sky's, a drawing kit that no code defines any more (the last kit, deleted with #835). Stage
 * and main still hold such Scrolls and serve them to an older app, so every server path that reads one still reads it (D-442): it is
 * served, Ask reads its stop, a moment of one of its stops is a valid snippet, and a place in it can be kept. Its stage is passed
 * through and never drawn by the server. Over real PostgreSQL, with the labelled CI fixture `seasons-stage-ci` (not product content).
 */
describe('a stored v2 Scroll with an Earth & sky stage (real PostgreSQL CI fixture)', () => {
  let database: TestDatabase<Database>;
  let c: Cases;
  let stored: Awaited<ReturnType<typeof seedDocumentV2>>;

  beforeAll(async () => {
    database = await createTestDatabase<Database>('stored_v2_stage');
    c = await scrollUseCases(database, { recording: true });
    stored = await seedDocumentV2(database.db, 'seasons-stage-ci');
  });
  afterAll(async () => {
    await c.close();
    await database.drop();
  });

  const ref = () => ({ assetId: stored.assetId, assetRevision: 1 });
  const withScope = () => makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 });
  async function inScope<T>(run: (scope: Parameters<Parameters<ReturnType<typeof withScope>>[1]>[0]) => Promise<T>) {
    const person = await recordingPerson(database);
    const entered = await withScope()(person.authority, run);
    if (entered.kind !== 'entered') throw new Error('CI scope refused');
    return entered.value;
  }

  it('is the fixture it claims to be: its stage names earth-sky.v1', () => {
    expect(stored.document.stage?.kit).toBe('earth-sky.v1');
  });

  it('is served whole, stage included, to a client that declares scroll-document.v2', async () => {
    const rendition = await c.renderScroll({ assetId: stored.assetId, revision: 1, capabilities: v2Client });
    if (rendition.kind !== 'rendition') throw new Error('CI expected a rendition');
    expect(rendition.document).toEqual(stored.document);
  });

  it('gives Ask the words of one of its stops', async () => {
    const stop = stored.document.stops.find((entry) => entry.kind === 'read');
    if (stop === undefined) throw new Error('the fixture has a read stop');
    const facts = await inScope((scope) => readScrollAskFacts(scope, ref(), stop.id));
    expect(facts?.title).toBe(stored.document.title);
    expect(facts?.suggestions).toEqual(stored.document.askSuggestions);
  });

  it('lets a person share one of its stops as a moment, and refuses a changed range', async () => {
    const stop = stored.document.stops.find((entry) => entry.kind === 'read');
    if (stop === undefined) throw new Error('the fixture has a read stop');
    const moment = momentOf(stored.document, stop.id);
    if (moment === undefined) throw new Error('a read stop is a moment');
    const anchor = momentAnchorOf(moment);
    const valid = await inScope((scope) => validateSnippetAnchor(scope, ref(), anchor));
    expect(valid).toMatchObject({ status: 'valid' });
    expect(await inScope((scope) => validateSnippetAnchor(scope, ref(), { ...anchor, end: anchor.end - 1 }))).toEqual({
      status: 'invalid',
    });
  });

  it('keeps a place in it: the target of its places is its stops, in order', async () => {
    const person = await recordingPerson(database);
    const access = accountAccessUseCases({ db: database.db, lockTimeoutMs: 10_000 });
    const result = await withScope()(person.authority, async (scope) => {
      const fence = await access.fenceOwnAccount(scope);
      if (fence.kind !== 'active') throw new Error('CI account fence failed');
      return lockKeepPositionTarget(scope, fence.owner, ref());
    });
    if (result.kind !== 'entered') throw new Error('CI scope refused');
    expect(result.value).toEqual({ kind: 'scroll', topLevelBlockIds: stored.document.stops.map((stop) => stop.id) });
  });

  it('is nothing for a revision it is not: another asset has no target and no Ask facts', async () => {
    const other = { assetId: randomUUID(), assetRevision: 1 };
    expect(
      await inScope((scope) => readScrollAskFacts(scope, other, stored.document.stops[0]?.id ?? 's1')),
    ).toBeUndefined();
  });
});
