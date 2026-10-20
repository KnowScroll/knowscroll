import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admitDocument, canonicalSha256 } from '@knowscroll/scroll-model';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import {
  COVERAGE_POLICY,
  CONCEPT_CATALOGUE_VERSION,
  type CoverageCommand,
  type CoverageMapping,
} from '@knowscroll/backend/modules/content';
import {
  importEditorialScrollUseCase,
  makeAdmitCoverage,
  makeCoverageAdmissionPorts,
  coverageAdmissionUseCase,
  coverageCatalogue,
  readAdmittedCoverageMapping,
  lockCurrentCoverageAuthorities,
} from '@knowscroll/backend/modules/content/nest-providers';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { seedAsset, seedPerson } from '../support/fixtures.js';
import { starterSource } from '../support/scroll.js';

/** These are synthetic mappings/semantic approvals, never a live catalogue admission or formation. */
describe('Content coverage sidecars (real PostgreSQL, CI fixtures only)', () => {
  let database: TestDatabase<Database>;
  const approved = new Map<string, string>();
  beforeAll(async () => {
    database = await createTestDatabase<Database>('content_coverage');
  });
  afterAll(async () => {
    await database.drop();
  });
  const fixtureAuthority = (digest: string, reference: string) => approved.get(digest) === reference;
  function review(command: CoverageCommand) {
    approved.set(canonicalSha256(command), command.semanticReviewReference);
    return command;
  }
  function admission() {
    return makeAdmitCoverage(makeCoverageAdmissionPorts(database.db, fixtureAuthority));
  }
  async function fixture() {
    const source = starterSource() as {
      assetId: string;
      reference: string;
      publication: { explanationUnitId: string };
      draft: { title: string };
    };
    source.assetId = randomUUID();
    source.reference = 'ci-coverage-only-not-live-semantics';
    source.publication.explanationUnitId = 'ci-coverage-unit-' + randomUUID();
    source.draft.title = 'CI fixture static coverage, not semantic approval';
    const result = await importEditorialScrollUseCase(database.db)(source);
    expect(result.kind).toBe('imported');
    const row = await database.db
      .selectFrom('content.asset_revisions')
      .select(['document', 'reading_facts'])
      .where('asset_id', '=', source.assetId)
      .where('revision', '=', 1)
      .executeTakeFirstOrThrow();
    const parsed = admitDocument(row.document);
    if (parsed.kind !== 'valid') throw new Error('fixture_document_invalid');
    const provenance = await database.db
      .selectFrom('content.asset_provenance')
      .select('provenance')
      .where('asset_id', '=', source.assetId)
      .where('revision', '=', 1)
      .executeTakeFirstOrThrow();
    const map: CoverageMapping = {
      version: COVERAGE_POLICY,
      documentSha256: parsed.document.integrity.sha256,
      provenanceSha256: canonicalSha256(provenance.provenance),
      explanationUnitId: parsed.document.explanationUnitId,
      framing: 'factual',
      framingSha256: canonicalSha256(parsed.document.framing),
      readingFactsVersion: 2,
      readingFactsSha256: canonicalSha256(row.reading_facts),
      catalogueVersion: CONCEPT_CATALOGUE_VERSION,
      catalogueSha256: coverageCatalogue.sha256,
      bindings: [
        {
          topicId: 'earth.seasons',
          facetId: 'earth.seasons.axial-tilt',
          meaningSha256: coverageCatalogue.meaningSha256('earth.seasons', 'earth.seasons.axial-tilt')!,
          requiredBlockIds: ['intro-look-up'],
        },
      ],
    };
    const command: CoverageCommand = {
      version: 'content-coverage-command.v1',
      assetId: source.assetId,
      assetRevision: 1,
      expectedHeadRevision: 0,
      semanticReviewReference: 'ci-fixture-only-semantic-review',
      change: { kind: 'admit', mapping: map },
    };
    return { command, map, source, before: canonicalSha256(row) };
  }
  async function read(command: CoverageCommand) {
    const person = await seedPerson(database.db);
    return makeWithPersonalScope(database.db, { lockTimeoutMs: 1000 })(person.authority, (scope) =>
      readAdmittedCoverageMapping(scope, { assetId: command.assetId, assetRevision: command.assetRevision }),
    );
  }
  it('default-denies unreviewed/forged strings, admits reviewed exact source, replays without history and preserves original bytes', async () => {
    const f = await fixture();
    expect(await read(f.command)).toMatchObject({ kind: 'entered', value: { kind: 'unmapped' } });
    await expect(coverageAdmissionUseCase(database.db)(review(f.command))).rejects.toThrow(
      'CONTENT_COVERAGE_REVIEW_REQUIRED',
    );
    await expect(admission()({ ...f.command, semanticReviewReference: 'forged-reference' })).rejects.toThrow(
      'CONTENT_COVERAGE_REVIEW_REQUIRED',
    );
    const first = await admission()(f.command);
    expect(Object.keys(first.authority).sort()).toEqual(['assetId', 'assetRevision', 'headRevision', 'mappingSha256']);
    expect(await admission()(f.command)).toEqual(first);
    expect(await read(f.command)).toMatchObject({ kind: 'entered', value: { kind: 'mapped', head: first } });
    const revisions = await sql<{
      count: number;
    }>`select count(*)::int as count from content.coverage_revisions where asset_id=${f.command.assetId}::uuid`.execute(
      database.db,
    );
    expect(revisions.rows[0]?.count).toBe(1);
    const row = await database.db
      .selectFrom('content.asset_revisions')
      .select(['document', 'reading_facts'])
      .where('asset_id', '=', f.command.assetId)
      .where('revision', '=', 1)
      .executeTakeFirstOrThrow();
    expect(canonicalSha256(row)).toBe(f.before);
    expect(
      await database.db
        .selectFrom('content.encounter_topics')
        .selectAll()
        .where('asset_id', '=', f.command.assetId)
        .execute(),
    ).toEqual([]);
  });
  it('rejects wrong revisions/documents/facts/locators/topics/framing without inserting a head', async () => {
    const f = await fixture();
    for (const change of [
      { ...f.command, assetRevision: 2 },
      { ...f.command, change: { kind: 'admit' as const, mapping: { ...f.map, documentSha256: 'a'.repeat(64) } } },
      { ...f.command, change: { kind: 'admit' as const, mapping: { ...f.map, readingFactsSha256: 'a'.repeat(64) } } },
      {
        ...f.command,
        change: {
          kind: 'admit' as const,
          mapping: { ...f.map, bindings: [{ ...f.map.bindings[0]!, requiredBlockIds: ['foreign'] }] },
        },
      },
      {
        ...f.command,
        change: {
          kind: 'admit' as const,
          mapping: { ...f.map, bindings: [{ ...f.map.bindings[0]!, topicId: 'earth.tides' }] },
        },
      },
    ])
      await expect(admission()(review(change))).rejects.toThrow();
    const reel = await seedAsset(database.db);
    await expect(admission()(review({ ...f.command, assetId: reel.assetId }))).rejects.toThrow(
      'CONTENT_COVERAGE_TARGET_UNAVAILABLE',
    );
    await expect(
      admission()(
        review({
          ...f.command,
          change: { kind: 'admit', mapping: { ...f.map, framing: 'hypothetical' as 'factual' } },
        }),
      ),
    ).rejects.toThrow();
    expect(await read(f.command)).toMatchObject({ kind: 'entered', value: { kind: 'unmapped' } });
  });
  it('enforces byte, list and duplicate authority bounds before locking targets', async () => {
    const f = await fixture();
    const oversized = {
      ...f.command,
      change: {
        kind: 'admit' as const,
        mapping: {
          ...f.map,
          bindings: Array.from({ length: 16 }, () => ({
            ...f.map.bindings[0]!,
            requiredBlockIds: Array.from({ length: 8 }, (_, i) => '🌍'.repeat(70) + String(i)),
          })),
        },
      },
    };
    await expect(admission()(review(oversized))).rejects.toThrow('CONTENT_COVERAGE_LIMIT');
    const head = await admission()(review(f.command));
    const person = await seedPerson(database.db);
    const withScope = makeWithPersonalScope(database.db, { lockTimeoutMs: 1000 });
    await expect(withScope(person.authority, (s) => lockCurrentCoverageAuthorities(s, []))).rejects.toThrow();
    await expect(
      withScope(person.authority, (s) =>
        lockCurrentCoverageAuthorities(s, [
          head.authority,
          { ...head.authority, assetId: head.authority.assetId.toUpperCase() },
        ]),
      ),
    ).rejects.toThrow('CONTENT_COVERAGE_AUTHORITY_LIMIT');
    await expect(
      withScope(person.authority, (s) =>
        lockCurrentCoverageAuthorities(
          s,
          Array.from({ length: 101 }, () => ({ ...head.authority, assetId: randomUUID() })),
        ),
      ),
    ).rejects.toThrow();
  });
  it('serializes concurrent heads; corrections A→B→A and retractions append, old authority refuses', async () => {
    const f = await fixture();
    const one = review(f.command);
    const other = review({ ...f.command, semanticReviewReference: 'ci-fixture-competing-review' });
    const results = await Promise.allSettled([admission()(one), admission()(other)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const winning = results.find((r) => r.status === 'fulfilled');
    if (winning?.status !== 'fulfilled') throw new Error('fixture_winner_missing');
    const person = await seedPerson(database.db);
    const withScope = makeWithPersonalScope(database.db, { lockTimeoutMs: 1000 });
    const a = winning.value;
    const b = await admission()(
      review({
        ...f.command,
        expectedHeadRevision: 1,
        change: {
          kind: 'admit',
          mapping: { ...f.map, bindings: [{ ...f.map.bindings[0]!, requiredBlockIds: ['intro-short-version'] }] },
        },
      }),
    );
    expect(b.authority.headRevision).toBe(2);
    const again = await admission()(review({ ...f.command, expectedHeadRevision: 2 }));
    expect(again.authority.mappingSha256).toBe(a.authority.mappingSha256);
    expect(again.authority.headRevision).toBe(3);
    expect(await withScope(person.authority, (s) => lockCurrentCoverageAuthorities(s, [a.authority]))).toEqual({
      kind: 'entered',
      value: false,
    });
    expect(await withScope(person.authority, (s) => lockCurrentCoverageAuthorities(s, [again.authority]))).toEqual({
      kind: 'entered',
      value: true,
    });
    await admission()(review({ ...f.command, expectedHeadRevision: 3, change: { kind: 'retract' } }));
    expect(await read(f.command)).toMatchObject({
      kind: 'entered',
      value: { kind: 'retracted', authority: { headRevision: 4 } },
    });
    expect(await withScope(person.authority, (s) => lockCurrentCoverageAuthorities(s, [again.authority]))).toEqual({
      kind: 'entered',
      value: false,
    });
    await expect(
      sql`update content.coverage_revisions set status='active' where asset_id=${f.command.assetId}::uuid`.execute(
        database.db,
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      sql`delete from content.coverage_revisions where asset_id=${f.command.assetId}::uuid`.execute(database.db),
    ).rejects.toMatchObject({ code: '23514' });
  });
  it('rolls a failed append back and blocks correction while a personal consumer holds current SHARE authority', async () => {
    const f = await fixture();
    const ports = makeCoverageAdmissionPorts(database.db, fixtureAuthority);
    const failed = makeAdmitCoverage({
      ...ports,
      append: async (...args) => {
        await ports.append(...args);
        throw new Error('fixture_rollback');
      },
    });
    await expect(failed(review(f.command))).rejects.toThrow('fixture_rollback');
    expect(await read(f.command)).toMatchObject({ kind: 'entered', value: { kind: 'unmapped' } });
    const head = await admission()(f.command);
    const person = await seedPerson(database.db);
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const consumer = makeWithPersonalScope(database.db, { lockTimeoutMs: 1000 })(person.authority, async (scope) => {
      expect(await lockCurrentCoverageAuthorities(scope, [head.authority])).toBe(true);
      entered();
      await held;
    });
    await ready;
    const next = review({ ...f.command, expectedHeadRevision: 1, change: { kind: 'retract' as const } });
    const correction = admission()(next);
    try {
      await expect
        .poll(async () => {
          const waits = await sql<{ count: number }>`select count(*)::int as count from pg_stat_activity
          where datname=current_database() and wait_event_type='Lock'`.execute(database.db);
          return waits.rows[0]?.count ?? 0;
        })
        .toBeGreaterThan(0);
    } finally {
      release();
    }
    await consumer;
    expect((await correction).authority.headRevision).toBe(2);
    await database.db
      .updateTable('content.assets')
      .set({ status: 'withdrawn' })
      .where('id', '=', f.command.assetId)
      .execute();
    expect(await read(f.command)).toMatchObject({ kind: 'entered', value: { kind: 'unavailable' } });
    await expect(
      admission()(
        review({
          ...f.command,
          expectedHeadRevision: 2,
          change: { kind: 'retract' },
          semanticReviewReference: 'ci-retract-withdrawn-sidecar',
        }),
      ),
    ).resolves.toMatchObject({ status: 'retracted', authority: { headRevision: 3 } });
  });
});
