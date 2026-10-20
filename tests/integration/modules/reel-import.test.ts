import { mkdtemp, rm, symlink, truncate, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { makeCutroomReelImporter, makeMediaAccess } from '@knowscroll/backend/modules/content/nest-providers';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { cutroomFixture, fixtureRunId } from '../support/cutroom-fixture.js';
import { seedPerson } from '../support/fixtures.js';
import { scrollUseCases, textCapabilities } from '../support/scroll.js';

describe('read-only Cutroom reuse (real database + generated fixture MP4)', () => {
  let database: TestDatabase<Database>;
  let fixture: Awaited<ReturnType<typeof cutroomFixture>>;
  let root: string;
  beforeAll(async () => {
    database = await createTestDatabase<Database>('reel_import');
    root = await mkdtemp(join(tmpdir(), 'ks-reel-'));
    fixture = await cutroomFixture(root);
  });
  afterAll(async () => {
    await fixture.close();
    await database.drop();
    await rm(root, { recursive: true, force: true });
  });
  const importer = (world = 'ci') =>
    makeCutroomReelImporter(database.db, {
      world,
      mediaRoot: fixture.mediaRoot,
      cutroomOrigin: fixture.origin,
      cutroomArtifactRoot: fixture.artifactRoot,
    });
  const command = { runId: fixtureRunId, script: 'greenhouse', fixture: true };

  it('refuses unapproved runs, fixture bytes outside local/ci, and real admission of fake bytes', async () => {
    expect(await importer('live')(command)).toMatchObject({ kind: 'refused', reason: 'world' });
    expect(await importer('dev')(command)).toMatchObject({ kind: 'refused', reason: 'fixture_world' });
    expect(await importer()({ ...command, runId: randomUUID() })).toMatchObject({ kind: 'refused', reason: 'run' });
    expect(await importer()({ ...command, fixture: false })).toMatchObject({ kind: 'refused', reason: 'file_changed' });
    expect((await sql`select * from content.reel_imports`.execute(database.db)).rows).toHaveLength(0);
  });
  it('refuses failed engine checks, mismatched identities, escape, symlink, oversize and invalid video', async () => {
    fixture.ready.ready = false;
    expect(await importer()(command)).toMatchObject({ kind: 'refused', reason: 'engine_not_ready' });
    fixture.ready.ready = true;
    fixture.record.takes[0]!.checks[0]!.outcome = 'fail';
    expect(await importer()(command)).toMatchObject({ kind: 'refused', reason: 'record' });
    fixture.record.takes[0]!.checks[0]!.outcome = 'accept';
    fixture.status.requestId = 'wrong';
    expect(await importer()(command)).toMatchObject({ kind: 'refused', reason: 'record' });
    fixture.status.requestId = fixture.result.requestId;
    const wrongRun = randomUUID();
    fixture.status.runId = wrongRun;
    fixture.result.runId = wrongRun;
    fixture.record.runId = wrongRun;
    // Coherent wrong identities are still not the requested approved run, even with its pinned path.
    expect(await importer()(command)).toMatchObject({ kind: 'refused', reason: 'record' });
    fixture.status.runId = fixtureRunId;
    fixture.result.runId = fixtureRunId;
    fixture.record.runId = fixtureRunId;
    const original = fixture.result.video.path;
    fixture.result.video.path = join(root, 'outside.mp4');
    await expect(importer()(command)).rejects.toThrow('artifact_unsafe');
    const backup = join(root, 'backup.mp4');
    await copyFile(original, backup);
    await rm(original);
    await symlink(backup, original);
    fixture.result.video.path = original;
    await expect(importer()(command)).rejects.toThrow('artifact_unsafe');
    await rm(original);
    await copyFile(backup, original);
    await truncate(original, 67108865);
    await expect(importer()(command)).rejects.toThrow('artifact_size');
    await truncate(original, 1);
    await expect(importer()(command)).rejects.toThrow();
    await copyFile(backup, original);
  });
  it('atomically admits immutable fixture media with engine-attested provenance and is run-idempotent', async () => {
    const first = await importer()(command);
    expect(first).toMatchObject({ kind: 'created', revision: 1 });
    const again = await importer()(command);
    expect(again).toMatchObject({ kind: 'unchanged' });
    expect((await sql`select * from content.reel_imports`.execute(database.db)).rows).toHaveLength(1);
    const rows = await database.db.selectFrom('content.asset_revisions').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.document).toMatchObject({
      fixture: true,
      truthLabel: 'generated',
      title: '[Fixture] A blanket made of gas',
    });
    expect(JSON.stringify(rows[0]?.document)).not.toContain(fixture.artifactRoot);
    const provenance = await database.db
      .selectFrom('content.asset_provenance')
      .select('provenance')
      .executeTakeFirstOrThrow();
    expect(provenance.provenance).toMatchObject({ witness: { label: 'engine-attested, not independent' } });
    expect(fixture.methods.every((method) => method === 'GET')).toBe(true);
  });
  it('opens Reel lineage but serves media only within the live owner scope and admitted revision', async () => {
    const person = await seedPerson(database.db);
    const stranger = await seedPerson(database.db);
    const useCases = await scrollUseCases(database);
    try {
      const opened = await useCases.openExposure(person.authority, {
        commandId: randomUUID(),
        target: { kind: 'reel', assetId: '2074e431-76a4-45be-b78f-3d65914277ff' },
        origin: { kind: 'direct' },
        capabilities: textCapabilities,
      });
      expect(opened.kind).toBe('opened');
      if (opened.kind !== 'opened') return;
      const access = makeMediaAccess(database.db);
      expect(await access(person.authority, opened.outcome.exposureId)).toBeDefined();
      expect(await access(stranger.authority, opened.outcome.exposureId)).toBeUndefined();
      await database.db
        .updateTable('identity.universes')
        .set({ privacy_epoch: 2 })
        .where('id', '=', person.universeId)
        .execute();
      expect(await access(person.authority, opened.outcome.exposureId)).toBeUndefined();
      await database.db
        .updateTable('content.assets')
        .set({ status: 'withdrawn' })
        .where('id', '=', opened.outcome.assetId)
        .execute();
      expect(await access({ ...person.authority, privacyEpoch: 2 }, opened.outcome.exposureId)).toBeUndefined();
    } finally {
      await useCases.close();
    }
  });
});
