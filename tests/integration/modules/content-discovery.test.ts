import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeWithPersonalScope, withTransaction, type Database } from '@knowscroll/backend/infrastructure/postgres';
import {
  importEditorialScrollUseCase,
  makeAdmissionStore,
  admitContinuity,
  readDiscoveryCandidates,
  readExactEncounter,
  readContinuations,
  resolveContinuityLink,
  readEncounterTopics,
  readSavedMetadata,
} from '@knowscroll/backend/modules/content/nest-providers';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { seedPerson } from '../support/fixtures.js';
import { starterSource, textCapabilities } from '../support/scroll.js';
/** Authored CI fixtures deliberately unrelated to approved producer briefs. */
function source(assetId: string, explanationUnitId: string, title = 'CI fixture sky explainer') {
  const s = starterSource() as {
    assetId: string;
    publication: { explanationUnitId: string };
    draft: { title: string; dek: string };
  };
  s.assetId = assetId;
  s.publication.explanationUnitId = explanationUnitId;
  s.draft.title = title;
  return s;
}
describe('admitted discovery, exact revision and explicit continuity (real PostgreSQL)', () => {
  let database: TestDatabase<Database>;
  beforeAll(async () => {
    database = await createTestDatabase<Database>('content_discovery');
  });
  afterAll(async () => {
    await database.drop();
  });
  it('projects real admitted metadata without treating arbitrary explanation IDs/titles as topic or series authority', async () => {
    const person = await seedPerson(database.db);
    const withScope = makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 });
    const id = randomUUID();
    const admit = importEditorialScrollUseCase(database.db);
    expect(await admit(source(id, 'legacy-cutroom-seasons-v5', 'CI fixture Part Two Seasons'))).toMatchObject({
      kind: 'imported',
    });
    const result = await withScope(person.authority, async (s) => ({
      candidate: await readExactEncounter(s, { assetId: id, assetRevision: 1, capabilities: textCapabilities }),
      topics: await readEncounterTopics(s, { assetId: id, assetRevision: 1 }),
      links: await readContinuations(s, { assetId: id, assetRevision: 1 }),
    }));
    expect(result).toMatchObject({
      kind: 'entered',
      value: { candidate: { assetId: id, topics: [], facets: [] }, topics: [], links: [] },
    });
    if (result.kind === 'entered') expect(result.value.candidate?.series).toBeUndefined();
    const query = { languages: ['en'], formats: ['scroll'] as const, capabilities: textCapabilities, limit: 100 };
    const discovery = await withScope(person.authority, (s) => readDiscoveryCandidates(s, query));
    expect(discovery.kind === 'entered' && discovery.value.some((c) => c.assetId === id)).toBe(true);
    expect(
      await withScope(person.authority, (s) => readDiscoveryCandidates(s, { ...query, languages: ['fr'] })),
    ).toMatchObject({ kind: 'entered', value: [] });
    expect(
      await withScope(person.authority, (s) =>
        readDiscoveryCandidates(s, { ...query, capabilities: { documentSchemas: ['unsupported.v1'], blocks: {} } }),
      ),
    ).toMatchObject({ kind: 'entered', value: [] });
    await expect(
      withScope(person.authority, (s) => readDiscoveryCandidates(s, { ...query, limit: 101 })),
    ).rejects.toThrow('DISCOVERY_QUERY_INVALID');
    const revised = source(id, 'legacy-cutroom-seasons-v5', 'CI fixture corrected wording');
    expect(await admit(revised)).toMatchObject({ kind: 'imported', revision: 2 });
    const saved = await withScope(person.authority, async (s) => ({
      old: await readExactEncounter(s, { assetId: id, assetRevision: 1, capabilities: textCapabilities }),
      metadata: await readSavedMetadata(s, [{ assetId: id, assetRevision: 1 }]),
    }));
    expect(saved).toMatchObject({
      kind: 'entered',
      value: {
        old: { assetRevision: 1, metadata: { title: 'CI fixture Part Two Seasons' } },
        metadata: [{ ref: { assetId: id, assetRevision: 1 }, availability: 'corrected', currentAssetRevision: 2 }],
      },
    });
    await database.db.updateTable('content.assets').set({ status: 'withdrawn' }).where('id', '=', id).execute();
    expect(
      await withScope(person.authority, (s) =>
        readExactEncounter(s, { assetId: id, assetRevision: 1, capabilities: textCapabilities }),
      ),
    ).toMatchObject({ kind: 'entered', value: undefined });
    expect(
      await withScope(person.authority, (s) => readSavedMetadata(s, [{ assetId: id, assetRevision: 1 }])),
    ).toMatchObject({ kind: 'entered', value: [{ availability: 'withdrawn' }] });
    const withdrawn = await withScope(person.authority, (s) =>
      readSavedMetadata(s, [{ assetId: id, assetRevision: 1 }]),
    );
    if (withdrawn.kind === 'entered') expect(withdrawn.value[0]?.metadata).toBeUndefined();
  });
  it('admits only declared adjacent series links; resolves exact immutable target and refuses stale/variant/foreign facts', async () => {
    const person = await seedPerson(database.db);
    const withScope = makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 });
    const admit = importEditorialScrollUseCase(database.db);
    const refs = Array.from({ length: 3 }, () => ({ assetId: randomUUID(), assetRevision: 1 }));
    for (const [i, r] of refs.entries())
      expect(await admit(source(r.assetId, `ci-discovery-unit-${String(i)}`))).toMatchObject({ kind: 'imported' });
    const a = refs[0]!;
    const b = refs[1]!;
    const c = refs[2]!;
    const store = makeAdmissionStore(database.db);
    const linkId = randomUUID();
    const relation = { kind: 'series_step' as const, seriesId: 'ci-fixture-series', seriesRevision: 1, part: 2 };
    const link = {
      linkId,
      revision: 1,
      source: a,
      target: b,
      direction: 'next' as const,
      relation,
      strength: 1,
      authorityReference: 'ci-fixture-authorized-series',
    };
    const input = {
      authorityReference: link.authorityReference,
      series: [{ seriesId: relation.seriesId, seriesRevision: 1, units: refs.map((r, i) => ({ ...r, part: i + 1 })) }],
      links: [link],
    };
    await store.inAdmission((tx) => admitContinuity(tx, input));
    await store.inAdmission((tx) => admitContinuity(tx, input));
    await expect(
      store.inAdmission((tx) =>
        admitContinuity(tx, {
          ...input,
          links: [],
          series: [{ ...input.series[0]!, units: input.series[0]!.units.slice(0, 2) }],
        }),
      ),
    ).rejects.toThrow('CONTINUITY_SERIES_CONFLICT');
    await expect(
      store.inAdmission((tx) =>
        admitContinuity(tx, { ...input, links: [], series: [{ ...input.series[0]!, seriesId: 'ci-other-series' }] }),
      ),
    ).rejects.toThrow('CONTINUITY_SERIES_CONTRADICTORY');

    expect(
      await withScope(person.authority, (s) => resolveContinuityLink(s, { linkId, source: a, target: b })),
    ).toMatchObject({ kind: 'entered', value: { linkId, target: b } });
    expect(
      await withScope(person.authority, (s) => resolveContinuityLink(s, { linkId, source: a, target: c })),
    ).toMatchObject({ kind: 'entered', value: undefined });
    await expect(
      store.inAdmission((tx) =>
        admitContinuity(tx, { ...input, links: [{ ...link, linkId: randomUUID(), target: c }] }),
      ),
    ).rejects.toThrow('CONTINUITY_NOT_DECLARED_NEIGHBOR');
    const replacement = { ...link, linkId: randomUUID(), revision: 2 };
    await store.inAdmission((tx) => admitContinuity(tx, { ...input, series: [], links: [replacement] }));
    expect(
      await withScope(person.authority, (s) => resolveContinuityLink(s, { linkId, source: a, target: b })),
    ).toMatchObject({ kind: 'entered', value: undefined });
    await database.db.updateTable('content.assets').set({ status: 'withdrawn' }).where('id', '=', b.assetId).execute();
    expect(await withScope(person.authority, (s) => readContinuations(s, a))).toMatchObject({
      kind: 'entered',
      value: [],
    });
    await expect(store.inAdmission((tx) => admitContinuity(tx, { ...input, links: [replacement] }))).rejects.toThrow(
      'CONTINUITY_REVISION_UNAVAILABLE',
    );
  });
  it('database rejects attribution that exceeds one and preserves immutable documents', async () => {
    const id = randomUUID();
    expect(await importEditorialScrollUseCase(database.db)(source(id, 'ci-weight-unit'))).toMatchObject({
      kind: 'imported',
    });
    const before = await database.db
      .selectFrom('content.asset_revisions')
      .select(['document', 'document_sha256'])
      .where('asset_id', '=', id)
      .executeTakeFirstOrThrow();
    await database.db
      .insertInto('content.encounter_topics')
      .values({ asset_id: id, asset_revision: 1, topic_id: 'ci.topic.a', role: 'primary', weight: 0.8 })
      .execute();
    await expect(
      database.db
        .insertInto('content.encounter_topics')
        .values({ asset_id: id, asset_revision: 1, topic_id: 'ci.topic.b', role: 'supporting', weight: 0.8 })
        .execute(),
    ).rejects.toThrow('CONTENT_ATTRIBUTION_INVALID');
    expect(
      await database.db
        .selectFrom('content.asset_revisions')
        .select(['document', 'document_sha256'])
        .where('asset_id', '=', id)
        .executeTakeFirstOrThrow(),
    ).toEqual(before);
    expect(
      (await sql`select * from content.encounter_topics where asset_id=${id}::uuid`.execute(database.db)).rows,
    ).toHaveLength(1);
  });
  it('approved run, script, media pins and completed import rows alone grant the mapped topic; rollback and pin mismatch grant none', async () => {
    // CI database fixture only: frozen authority metadata, not playback or independent byte verification.
    const approved = JSON.parse(
      readFileSync(
        new URL('../../../packages/backend/src/modules/content/approved/seasons-v5.json', import.meta.url),
        'utf8',
      ),
    ) as { approvedRunId: string; approvedMediaSha256: string; approvedMediaBytes: number };
    const person = await seedPerson(database.db);
    const withScope = makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 });
    const write = async (
      db: TestDatabase<Database>['db'],
      runId: string,
      sha: string,
      abort = false,
      fixture = false,
      script = 'seasons-v5',
    ) => {
      const assetId = randomUUID();
      const mediaId = randomUUID();
      await db
        .insertInto('content.assets')
        .values({ id: assetId, kind: 'reel', status: 'admitted', revision: 1 })
        .execute();
      await db
        .insertInto('content.asset_revisions')
        .values({
          asset_id: assetId,
          revision: 1,
          provenance_kind: 'cutroom_import',
          document_version: 'reel-document.v1',
          document: JSON.stringify({ schemaVersion: 'ci-fixture-authority-only', title: 'CI fixture pinned metadata' }),
          document_sha256: 'a'.repeat(64),
          explanation_unit_id: 'legacy-cutroom-seasons-v5',
          language: 'en',
          title: 'CI fixture pinned metadata',
          reading_facts: '{}',
        })
        .execute();
      await db
        .insertInto('content.media_objects')
        .values({
          id: mediaId,
          backend: 'local',
          logical_key: `sha256/${sha.slice(0, 2)}/${sha}.mp4`,
          sha256: sha,
          size_bytes: approved.approvedMediaBytes,
          mime: 'video/mp4',
          probe: '{}',
        })
        .execute();
      await db
        .insertInto('content.reel_imports')
        .values({
          run_id: runId,
          asset_id: assetId,
          asset_revision: 1,
          media_id: mediaId,
          script_name: script,
          fixture,
        })
        .execute();
      if (abort) throw new Error('CI fixture import abort');
      return assetId;
    };
    // Admission uses its existing marked transaction; the test never opens an unmarked production transaction.
    const before = (await sql`select asset_id from content.encounter_topics`.execute(database.db)).rows.length;
    for (const bad of [
      { run: randomUUID(), sha: approved.approvedMediaSha256, fixture: false, script: 'seasons-v5' },
      { run: approved.approvedRunId, sha: 'c'.repeat(64), fixture: false, script: 'seasons-v5' },
      { run: approved.approvedRunId, sha: approved.approvedMediaSha256, fixture: true, script: 'seasons-v5' },
      { run: approved.approvedRunId, sha: approved.approvedMediaSha256, fixture: false, script: 'greenhouse' },
    ]) {
      await expect(
        withTransaction(database.db, 'ci.fixture-import', async (tx) => {
          const assetId = await write(tx, bad.run, bad.sha, false, bad.fixture, bad.script);
          expect(
            (await sql`select topic_id from content.encounter_topics where asset_id=${assetId}::uuid`.execute(tx)).rows,
          ).toHaveLength(0);
          throw new Error('CI fixture import abort');
        }),
      ).rejects.toThrow('CI fixture import abort');
    }
    // A correctly pinned completed import still leaves no partial projection when its transaction rolls back.
    await expect(
      withTransaction(database.db, 'ci.fixture-import', (tx) =>
        write(tx, approved.approvedRunId, approved.approvedMediaSha256, true),
      ),
    ).rejects.toThrow('CI fixture import abort');
    expect((await sql`select asset_id from content.encounter_topics`.execute(database.db)).rows.length).toBe(before);
    const valid = await write(database.db, approved.approvedRunId, approved.approvedMediaSha256);
    expect(
      await withScope(person.authority, (s) => readEncounterTopics(s, { assetId: valid, assetRevision: 1 })),
    ).toMatchObject({ kind: 'entered', value: [{ topicId: 'earth.seasons', role: 'primary', weight: 1 }] });
  });
});
