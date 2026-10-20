import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InteractionEvent } from '@knowscroll/contracts';
import { createBoss, drainConsumers, jobConsumer, startConsumers } from '@knowscroll/backend/infrastructure/jobs';
import { SCOPE_NOTICE_CHANNEL, ScopeNoticeSchema, type ScopeNotice } from '@knowscroll/backend/infrastructure/notices';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { projectScrollReadingQueue } from '@knowscroll/backend/modules/evidence';
import { coverageOf, parseDocument } from '@knowscroll/scroll-model';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';
import { activatedAgo, coverage, dwell, event, openActive, type OpenedFixture } from '../support/observations.js';
import { admitStarter, scrollUseCases } from '../support/scroll.js';

describe('projection and §8 qualification of a Scroll reading (real database)', () => {
  let database: TestDatabase<Database>;
  let useCases: Awaited<ReturnType<typeof scrollUseCases>>;
  let starter: { assetId: string; revision: number };
  let blocks: string[];
  beforeAll(async () => {
    database = await createTestDatabase<Database>('scroll_evidence');
    useCases = await scrollUseCases(database);
    starter = await admitStarter(useCases.importScroll);
    const facts = await database.db
      .selectFrom('content.asset_revisions')
      .select('reading_facts')
      .where('asset_id', '=', starter.assetId)
      .executeTakeFirstOrThrow();
    blocks = (facts.reading_facts as { blocks: { id: string }[] }).blocks.map((block) => block.id);
  });
  afterAll(async () => {
    await useCases.close();
    await database.drop();
  });

  /** A person with an exposure activated half an hour ago, so honest claims fit the elapsed time. */
  async function reader(): Promise<{ person: FixturePerson; exposure: OpenedFixture }> {
    const person = await seedPerson(database.db);
    const exposure = await openActive(useCases, person, starter);
    await activatedAgo(database.db, exposure.exposureId, 30);
    return { person, exposure };
  }

  const ingest = (person: FixturePerson, events: readonly InteractionEvent[], instrumentationVersion = 1) =>
    useCases.ingestObservations(person.authority, { instrumentationVersion, events });

  const project = (person: FixturePerson, exposure: OpenedFixture, privacyEpoch = 1) =>
    useCases.projectScrollReading({
      v: 1,
      universeId: person.universeId,
      privacyEpoch,
      exposureId: exposure.exposureId,
    });

  async function evidence(person: FixturePerson, exposure: OpenedFixture) {
    return database.db
      .selectFrom('evidence.encounter_evidence')
      .selectAll()
      .where('universe_id', '=', person.universeId)
      .where('exposure_id', '=', exposure.exposureId)
      .orderBy('revision')
      .execute();
  }

  const universeRevision = async (person: FixturePerson) =>
    (
      await database.db
        .selectFrom('identity.universes')
        .select('revision')
        .where('id', '=', person.universeId)
        .executeTakeFirstOrThrow()
    ).revision;

  it('qualifies a full reading: code-set weights, the versioned policy and the §8 formula', async () => {
    const { person, exposure } = await reader();
    await ingest(person, [event(exposure, coverage(blocks, 4_000)), event(exposure, dwell([0, 68_000]))]);
    const result = await project(person, exposure);
    expect(result).toMatchObject({ kind: 'applied', revision: 1, qualification: 'qualified' });
    const [row] = await evidence(person, exposure);
    expect(row).toMatchObject({
      revision: 1,
      input_watermark: 2,
      policy_version: 'scroll-qualification.v0',
      qualification: 'qualified',
      coverage: 1,
      active_dwell_ms: 68_000,
      asset_id: starter.assetId,
      asset_revision: starter.revision,
      privacy_epoch: 1,
    });
    // q = 0.5 · 1 + 0.5 · (68 s / the document's estimated reading time)
    expect(row?.q).toBeCloseTo(0.5 + (0.5 * 68_000) / (row?.estimated_reading_ms ?? 1), 3);
    expect(row?.summary).toMatchObject({ v: 1, reasons: [], sequenceGaps: 0, coverageEvents: 1, dwellEvents: 1 });
    expect(await universeRevision(person)).toBe(1);
  });

  it("weights coverage by the document's block weights, as scroll-model's coverageOf does", async () => {
    const { person, exposure } = await reader();
    const seen = [blocks[0] ?? '', blocks[3] ?? '', blocks[6] ?? '', 'violet-eye-cones'];
    await ingest(person, [event(exposure, coverage(seen, 3_000)), event(exposure, dwell([0, 12_000]))]);
    await project(person, exposure);
    const stored = await database.db
      .selectFrom('content.asset_revisions')
      .select('document')
      .where('asset_id', '=', starter.assetId)
      .executeTakeFirstOrThrow();
    const parsed = parseDocument(stored.document);
    if (parsed.kind !== 'valid') throw new Error('stored document invalid');
    const expected = coverageOf(parsed.document, seen).fraction;
    const [row] = await evidence(person, exposure);
    expect(row?.coverage).toBeCloseTo(expected, 4);
    // A nested block counted for the disclosure that owns it.
    expect((row?.summary as { seenBlocks: string[] }).seenBlocks).toContain('violet-eye');
    expect(row?.qualification).toBe('not_qualified');
  });

  it('classifies a short but fully instrumented reading as not_qualified, never unknown', async () => {
    const { person, exposure } = await reader();
    await ingest(person, [event(exposure, coverage([blocks[0] ?? ''], 2_000)), event(exposure, dwell([0, 2_000]))]);
    await project(person, exposure);
    const [row] = await evidence(person, exposure);
    expect(row).toMatchObject({ qualification: 'not_qualified', active_dwell_ms: 2_000 });
    expect((row?.summary as { reasons: string[] }).reasons).toEqual(['coverage_below_minimum']);
  });

  it('leaves the qualification unknown when the instrumentation is missing: coverage without dwell', async () => {
    const { person, exposure } = await reader();
    await ingest(person, [event(exposure, coverage(blocks.slice(0, 4), 4_000))]);
    await project(person, exposure);
    const [row] = await evidence(person, exposure);
    expect(row?.qualification).toBe('unknown');
    expect((row?.summary as { reasons: string[] }).reasons).toContain('instrumentation_missing');
    // Visible time only counts while the article was active: no dwell report, no seen blocks.
    expect(row?.coverage).toBe(0);
  });

  it('keeps a short reading unknown when events were lost, but never discards a reading that already qualifies', async () => {
    const lost = await reader();
    const session = randomUUID();
    await ingest(lost.person, [
      event(lost.exposure, coverage([blocks[0] ?? ''], 2_000), { sessionId: session, deviceSequence: 1 }),
      // sequence 2 never arrived
      event(lost.exposure, dwell([0, 2_000]), { sessionId: session, deviceSequence: 3 }),
    ]);
    await project(lost.person, lost.exposure);
    const [short] = await evidence(lost.person, lost.exposure);
    expect(short?.qualification).toBe('unknown');
    expect((short?.summary as { reasons: string[]; sequenceGaps: number }).reasons).toContain('sequence_gaps');
    expect((short?.summary as { sequenceGaps: number }).sequenceGaps).toBe(1);

    const enough = await reader();
    await ingest(enough.person, [
      event(enough.exposure, coverage(blocks, 4_000), { sessionId: session, deviceSequence: 1 }),
      event(enough.exposure, dwell([0, 68_000]), { sessionId: session, deviceSequence: 3 }),
    ]);
    await project(enough.person, enough.exposure);
    expect((await evidence(enough.person, enough.exposure))[0]?.qualification).toBe('qualified');
  });

  it('adds nothing for duplicates, overlap, background time, a brief flick or a barely visible block', async () => {
    const { person, exposure } = await reader();
    const first = blocks[0] ?? '';
    const second = blocks[1] ?? '';
    const third = blocks[2] ?? '';
    await ingest(person, [
      // The same minute of active time reported twice, differently framed.
      event(exposure, dwell([0, 10_000])),
      event(exposure, dwell([5_000, 10_000])),
      event(exposure, dwell([0, 10_000])),
      // `first` visible for 10 s inside active time, reported twice: counted once.
      event(exposure, {
        kind: 'scroll.block_coverage',
        payload: { blocks: [{ blockId: first, intervalsMs: [[0, 10_000]], peakFraction: 1 }] },
      }),
      event(exposure, {
        kind: 'scroll.block_coverage',
        payload: { blocks: [{ blockId: first, intervalsMs: [[2_000, 8_000]], peakFraction: 1 }] },
      }),
      // `second` was visible only while the app was in the background (outside every active interval).
      event(exposure, {
        kind: 'scroll.block_coverage',
        payload: { blocks: [{ blockId: second, intervalsMs: [[20_000, 30_000]], peakFraction: 1 }] },
      }),
      // `third` was a flick: 200 ms, and another block never reached half visible.
      event(exposure, {
        kind: 'scroll.block_coverage',
        payload: {
          blocks: [
            { blockId: third, intervalsMs: [[1_000, 1_200]], peakFraction: 1 },
            { blockId: blocks[3] ?? '', intervalsMs: [[0, 9_000]], peakFraction: 0.3 },
          ],
        },
      }),
    ]);
    await project(person, exposure);
    const [row] = await evidence(person, exposure);
    expect(row?.active_dwell_ms).toBe(10_000);
    expect((row?.summary as { seenBlocks: string[] }).seenBlocks).toEqual([first]);
    expect(row?.qualification).toBe('not_qualified');
  });

  it('counts a deliberate interaction once per block and kind, however often it is reported', async () => {
    const { person, exposure } = await reader();
    const interaction = (kind: 'disclosure' | 'drag') =>
      event(exposure, { kind: 'scroll.block_interaction', payload: { blockId: 'violet-eye', kind, atMs: 1_000 } });
    await ingest(person, [
      interaction('disclosure'),
      interaction('disclosure'),
      interaction('drag'),
      event(exposure, coverage([blocks[0] ?? ''], 1_000)),
      event(exposure, dwell([0, 1_000])),
    ]);
    await project(person, exposure);
    const [row] = await evidence(person, exposure);
    expect((row?.summary as { interactions: unknown[] }).interactions).toEqual([
      { blockId: 'violet-eye', interaction: 'disclosure' },
      { blockId: 'violet-eye', interaction: 'drag' },
    ]);
  });

  it('is a no-op on redelivery, and a new observation makes the next revision at the new watermark', async () => {
    const { person, exposure } = await reader();
    await ingest(person, [event(exposure, coverage(blocks.slice(0, 2), 3_000)), event(exposure, dwell([0, 6_000]))]);
    expect(await project(person, exposure)).toMatchObject({ kind: 'applied', revision: 1 });
    expect(await project(person, exposure)).toEqual({ kind: 'skipped', reason: 'already_applied' });
    expect(await project(person, exposure)).toEqual({ kind: 'skipped', reason: 'already_applied' });
    expect(await evidence(person, exposure)).toHaveLength(1);
    expect(await universeRevision(person)).toBe(1);

    await ingest(person, [event(exposure, dwell([6_000, 9_000]))]);
    expect(await project(person, exposure)).toMatchObject({ kind: 'applied', revision: 2 });
    const rows = await evidence(person, exposure);
    expect(rows.map((row) => [row.revision, row.input_watermark, row.active_dwell_ms])).toEqual([
      [1, 2, 6_000],
      [2, 3, 9_000],
    ]);
    expect(await universeRevision(person)).toBe(2);
    // The same watermark under the same policy cannot be inserted twice, whatever the job does.
    await expect(
      sql`insert into evidence.encounter_evidence (universe_id, id, exposure_id, revision, input_watermark, policy_version, qualification, q, coverage, active_dwell_ms, estimated_reading_ms, asset_id, asset_revision, summary, privacy_epoch)
        select universe_id, gen_random_uuid(), exposure_id, 3, input_watermark, policy_version, qualification, q, coverage, active_dwell_ms, estimated_reading_ms, asset_id, asset_revision, summary, privacy_epoch
        from evidence.encounter_evidence where universe_id = ${person.universeId} and revision = 2`.execute(
        database.db,
      ),
    ).rejects.toThrow();
  });

  it('serialises two projection jobs for one watermark: one revision', async () => {
    const { person, exposure } = await reader();
    await ingest(person, [event(exposure, coverage(blocks.slice(0, 2), 3_000)), event(exposure, dwell([0, 6_000]))]);
    const results = await Promise.all([project(person, exposure), project(person, exposure)]);
    expect(results.map((result) => (result.kind === 'applied' ? 'applied' : result.reason)).sort()).toEqual([
      'already_applied',
      'applied',
    ]);
    expect(await evidence(person, exposure)).toHaveLength(1);
  });

  it('skips work for an older privacy epoch, a missing exposure and an exposure without observations', async () => {
    const { person, exposure } = await reader();
    await ingest(person, [event(exposure, dwell([0, 1_000]))]);
    await sql`update identity.universes set privacy_epoch = 2 where id = ${person.universeId}`.execute(database.db);
    expect(await project(person, exposure, 1)).toEqual({ kind: 'skipped', reason: 'epoch_changed' });
    expect(await evidence(person, exposure)).toEqual([]);

    const quiet = await reader();
    expect(await project(quiet.person, quiet.exposure)).toEqual({ kind: 'skipped', reason: 'no_observations' });
    expect(
      await useCases.projectScrollReading({
        v: 1,
        universeId: quiet.person.universeId,
        privacyEpoch: 1,
        exposureId: randomUUID(),
      }),
    ).toEqual({ kind: 'skipped', reason: 'exposure_missing' });
  });

  it('sends one disposable scope hint after the evidence commit, naming the evidence and the new revision', async () => {
    const { person, exposure } = await reader();
    await ingest(person, [event(exposure, coverage(blocks.slice(0, 2), 3_000)), event(exposure, dwell([0, 6_000]))]);
    const listener = new pg.Client({ connectionString: database.settings.url });
    await listener.connect();
    const notices: ScopeNotice[] = [];
    listener.on('notification', (message) => {
      if (message.channel === SCOPE_NOTICE_CHANNEL && message.payload !== undefined) {
        const parsed = ScopeNoticeSchema.parse(JSON.parse(message.payload));
        if (parsed.scope.id === person.universeId) notices.push(parsed);
      }
    });
    await listener.query(`listen ${SCOPE_NOTICE_CHANNEL}`);
    try {
      await project(person, exposure);
      await project(person, exposure);
      await expect.poll(() => notices.length, { timeout: 10_000 }).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(notices).toHaveLength(1);
      const [row] = await evidence(person, exposure);
      expect(notices[0]).toEqual({
        v: 1,
        scope: { kind: 'universe', id: person.universeId },
        revision: 1,
        eventId: row?.id,
      });
      // The hint carries no content: only the scope, the revision and the evidence's ID.
      expect(JSON.stringify(notices[0])).not.toContain(exposure.exposureId);
    } finally {
      await listener.end();
    }
  });

  it("reads the committed evidence watermark for the dev diagnostics view, only for the caller's own universe", async () => {
    const { person, exposure } = await reader();
    const before = await useCases.readEvidenceDiagnostics(person.authority, exposure.exposureId);
    expect(before).toMatchObject({
      kind: 'read',
      diagnostics: { revision: 0, observations: { count: 0 }, evidence: undefined },
    });
    await ingest(person, [event(exposure, coverage(blocks, 4_000)), event(exposure, dwell([0, 68_000]))]);
    await project(person, exposure);
    const after = await useCases.readEvidenceDiagnostics(person.authority, exposure.exposureId);
    expect(after).toMatchObject({
      kind: 'read',
      diagnostics: {
        revision: 1,
        exposureId: exposure.exposureId,
        observations: { count: 2 },
        evidence: {
          revision: 1,
          inputWatermark: 2,
          qualification: 'qualified',
          policyVersion: 'scroll-qualification.v0',
        },
      },
    });
    const stranger = await seedPerson(database.db);
    expect(await useCases.readEvidenceDiagnostics(stranger.authority, exposure.exposureId)).toMatchObject({
      kind: 'read',
      diagnostics: { observations: { count: 0 }, evidence: undefined },
    });
    await sql`update identity.universes set privacy_epoch = 2 where id = ${person.universeId}`.execute(database.db);
    expect(await useCases.readEvidenceDiagnostics(person.authority, exposure.exposureId)).toEqual({
      kind: 'refused',
      reason: 'epoch_changed',
    });
  });

  it('is projected by the worker through pg-boss: intake enqueues, the consumer commits the evidence', async () => {
    const { person, exposure } = await reader();
    const worker = createBoss(database.settings, 'consumer', { onError: () => undefined, onWarning: () => undefined });
    await worker.start();
    await startConsumers(
      worker,
      [jobConsumer(projectScrollReadingQueue, async (payload) => void (await useCases.projectScrollReading(payload)))],
      () => undefined,
    );
    try {
      await ingest(person, [event(exposure, coverage(blocks, 4_000)), event(exposure, dwell([0, 68_000]))]);
      await expect
        .poll(async () => (await evidence(person, exposure)).length, { timeout: 30_000, interval: 250 })
        .toBe(1);
      expect((await evidence(person, exposure))[0]?.qualification).toBe('qualified');
    } finally {
      await drainConsumers(worker, 1, 5_000, () => undefined);
    }
  });
});
