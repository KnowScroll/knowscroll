import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { seedAsset, seedPerson, type FixturePerson } from '../support/fixtures.js';
import { admitStarter, baselineCapabilities, scrollUseCases, textCapabilities } from '../support/scroll.js';

describe('experience open, activate and the document read (real database)', () => {
  let database: TestDatabase<Database>;
  let useCases: Awaited<ReturnType<typeof scrollUseCases>>;
  let starter: { assetId: string; revision: number };
  beforeAll(async () => {
    database = await createTestDatabase<Database>('exposures');
    useCases = await scrollUseCases(database);
    starter = await admitStarter(useCases.importScroll);
  });
  afterAll(async () => {
    await useCases.close();
    await database.drop();
  });

  const open = (
    person: FixturePerson,
    commandId = randomUUID(),
    assetId = starter.assetId,
    capabilities = textCapabilities,
  ) =>
    useCases.openExposure(person.authority, {
      commandId,
      target: { kind: 'scroll', assetId },
      origin: { kind: 'direct' },
      capabilities,
    });

  async function counts(universeId: string) {
    const count = async (table: 'experience.exposures' | 'receipts.personal_commands') =>
      Number(
        (
          await database.db
            .selectFrom(table)
            .select((eb) => eb.fn.countAll<string>().as('n'))
            .where('universe_id', '=', universeId)
            .executeTakeFirstOrThrow()
        ).n,
      );
    return { exposures: await count('experience.exposures'), receipts: await count('receipts.personal_commands') };
  }

  it('opens a Scroll with lineage and replays the stored outcome for the same command', async () => {
    const person = await seedPerson(database.db);
    const commandId = randomUUID();
    const first = await open(person, commandId);
    expect(first).toMatchObject({
      kind: 'opened',
      replayed: false,
      outcome: { assetId: starter.assetId, assetRevision: starter.revision, kind: 'scroll', revision: 0 },
    });
    if (first.kind !== 'opened') return;
    const stored = await database.db
      .selectFrom('experience.exposures')
      .selectAll()
      .where('universe_id', '=', person.universeId)
      .executeTakeFirstOrThrow();
    expect(stored).toMatchObject({
      id: first.outcome.exposureId,
      asset_id: starter.assetId,
      asset_revision: starter.revision,
      kind: 'scroll',
      origin: 'direct',
      command_id: commandId,
      privacy_epoch: 1,
      activated_at: null,
    });
    expect(stored.capabilities).toEqual(textCapabilities);

    const replay = await open(person, commandId);
    expect(replay).toEqual({ kind: 'opened', outcome: first.outcome, replayed: true });
    expect(await counts(person.universeId)).toEqual({ exposures: 1, receipts: 1 });
  });

  it('refuses the same command ID for another request, and writes nothing for it', async () => {
    const person = await seedPerson(database.db);
    const commandId = randomUUID();
    await open(person, commandId);
    expect(await open(person, commandId, starter.assetId, baselineCapabilities)).toEqual({
      kind: 'refused',
      reason: 'command_key_reused',
    });
    expect(await counts(person.universeId)).toEqual({ exposures: 1, receipts: 1 });
  });

  it('answers a missing, withdrawn or non-Scroll asset with a retryable refusal and no receipt', async () => {
    const person = await seedPerson(database.db);
    const reel = await seedAsset(database.db);
    const withdrawn = await admitStarter(useCases.importScroll);
    expect(await open(person, randomUUID(), randomUUID())).toEqual({ kind: 'refused', reason: 'asset_not_found' });
    expect(await open(person, randomUUID(), reel.assetId)).toEqual({ kind: 'refused', reason: 'asset_not_found' });
    await sql`update content.assets set status = 'withdrawn' where id = ${withdrawn.assetId}`.execute(database.db);
    try {
      expect(await open(person, randomUUID(), withdrawn.assetId)).toEqual({
        kind: 'refused',
        reason: 'asset_not_found',
      });
      expect(await counts(person.universeId)).toEqual({ exposures: 0, receipts: 0 });
    } finally {
      await sql`update content.assets set status = 'admitted' where id = ${withdrawn.assetId}`.execute(database.db);
    }
  });

  it('refuses a stale privacy epoch: nothing is written', async () => {
    const person = await seedPerson(database.db, { privacyEpoch: 2 });
    const stale = { ...person.authority, privacyEpoch: 1 };
    expect(
      await useCases.openExposure(stale, {
        commandId: randomUUID(),
        target: { kind: 'scroll', assetId: starter.assetId },
        origin: { kind: 'direct' },
        capabilities: textCapabilities,
      }),
    ).toEqual({ kind: 'refused', reason: 'epoch_changed' });
    expect(await counts(person.universeId)).toEqual({ exposures: 0, receipts: 0 });
  });

  it('activates once: the activation time never moves, and a retry replays', async () => {
    const person = await seedPerson(database.db);
    const opened = await open(person);
    if (opened.kind !== 'opened') throw new Error('fixture open refused');
    const exposureId = opened.outcome.exposureId;
    const commandId = randomUUID();
    const first = await useCases.activateExposure(person.authority, { commandId, exposureId });
    expect(first).toMatchObject({ kind: 'activated', replayed: false });
    if (first.kind !== 'activated') return;
    expect(await useCases.activateExposure(person.authority, { commandId, exposureId })).toEqual({
      kind: 'activated',
      outcome: first.outcome,
      replayed: true,
    });
    // A new command for an exposure that is already active answers its original time.
    const second = await useCases.activateExposure(person.authority, { commandId: randomUUID(), exposureId });
    expect(second).toMatchObject({
      kind: 'activated',
      replayed: false,
      outcome: { activatedAt: first.outcome.activatedAt },
    });
    const row = await database.db
      .selectFrom('experience.exposures')
      .select('activated_at')
      .where('universe_id', '=', person.universeId)
      .where('id', '=', exposureId)
      .executeTakeFirstOrThrow();
    expect(new Date(row.activated_at ?? 0).toISOString()).toBe(first.outcome.activatedAt);
  });

  it("answers another person's exposure and an unknown one the same way (no oracle), for activation and the document", async () => {
    const owner = await seedPerson(database.db);
    const stranger = await seedPerson(database.db);
    const opened = await open(owner);
    if (opened.kind !== 'opened') throw new Error('fixture open refused');
    const exposureId = opened.outcome.exposureId;
    expect(await useCases.activateExposure(stranger.authority, { commandId: randomUUID(), exposureId })).toEqual({
      kind: 'refused',
      reason: 'exposure_not_found',
    });
    expect(
      await useCases.activateExposure(owner.authority, { commandId: randomUUID(), exposureId: randomUUID() }),
    ).toEqual({
      kind: 'refused',
      reason: 'exposure_not_found',
    });
    expect(await useCases.readExposureDocument(stranger.authority, exposureId)).toEqual({
      kind: 'refused',
      reason: 'exposure_not_found',
    });
    const row = await database.db
      .selectFrom('experience.exposures')
      .select('activated_at')
      .where('id', '=', exposureId)
      .executeTakeFirstOrThrow();
    expect(row.activated_at).toBeNull();
  });

  it("reads the exposure's document negotiated for the declared capabilities, never its provenance", async () => {
    const person = await seedPerson(database.db);
    const opened = await open(person);
    if (opened.kind !== 'opened') throw new Error('fixture open refused');
    const read = await useCases.readExposureDocument(person.authority, opened.outcome.exposureId);
    expect(read).toMatchObject({ kind: 'document', assetId: starter.assetId, assetRevision: starter.revision });
    if (read.kind !== 'document') return;
    expect(read.degradedEssential).toEqual([]);
    expect(read.document.title).toBe('Why the sky is blue');
    const serialised = JSON.stringify(read);
    for (const internal of ['authored-editorial', 'editorial-starter-sky-blue', 'scroll-provenance', 'bindings'])
      expect(serialised).not.toContain(internal);
  });

  it('gives a client that renders only the baseline readable fallbacks and names the essential ones', async () => {
    const person = await seedPerson(database.db);
    const opened = await open(person, randomUUID(), starter.assetId, baselineCapabilities);
    if (opened.kind !== 'opened') throw new Error('fixture open refused');
    const read = await useCases.readExposureDocument(person.authority, opened.outcome.exposureId);
    if (read.kind !== 'document') throw new Error('document refused');
    const types = read.document.sections.flatMap((section) => section.blocks.map((block) => block.type));
    expect(types).toContain('fallback');
    expect(types).not.toContain('list');
    expect(read.degradedEssential.map((entry) => entry.blockId)).toContain('rule-steps');
    // A rendition of a stored revision says what it is a rendition of.
    expect(read.document.rendition?.of).toBe(read.document.integrity.sha256);
  });

  it('refuses a document read after the privacy epoch changed, and for a client that cannot render the baseline', async () => {
    const person = await seedPerson(database.db);
    const none = await open(person, randomUUID(), starter.assetId, {
      documentSchemas: ['scroll-document.v1'],
      blocks: { paragraph: [1] },
    });
    if (none.kind !== 'opened') throw new Error('fixture open refused');
    expect(await useCases.readExposureDocument(person.authority, none.outcome.exposureId)).toEqual({
      kind: 'refused',
      reason: 'cannot_render',
      cannotRender: 'missing_baseline',
    });
    await sql`update identity.universes set privacy_epoch = 2 where id = ${person.universeId}`.execute(database.db);
    expect(await useCases.readExposureDocument(person.authority, none.outcome.exposureId)).toEqual({
      kind: 'refused',
      reason: 'epoch_changed',
    });
  });
});
