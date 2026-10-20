import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { admitDocument } from '@knowscroll/scroll-model';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { seedAsset } from '../support/fixtures.js';
import { scrollUseCases, starterSource } from '../support/scroll.js';

describe('content admission of the authored starter Scroll (real database)', () => {
  let database: TestDatabase<Database>;
  let useCases: Awaited<ReturnType<typeof scrollUseCases>>;
  beforeAll(async () => {
    database = await createTestDatabase<Database>('content_admission');
    useCases = await scrollUseCases(database);
  });
  afterAll(async () => {
    await useCases.close();
    await database.drop();
  });

  async function rows(assetId: string) {
    const revisions = await database.db
      .selectFrom('content.asset_revisions')
      .select(['revision', 'provenance_kind', 'document_version', 'document_sha256', 'document'])
      .where('asset_id', '=', assetId)
      .orderBy('revision')
      .execute();
    const provenance = await database.db
      .selectFrom('content.asset_provenance')
      .select(['revision', 'provenance_version', 'provenance'])
      .where('asset_id', '=', assetId)
      .orderBy('revision')
      .execute();
    const asset = await database.db
      .selectFrom('content.assets')
      .select(['kind', 'status', 'revision'])
      .where('id', '=', assetId)
      .executeTakeFirst();
    return { revisions, provenance, asset };
  }

  /** The source with one paragraph's words changed: a different file. */
  function editedSource(assetId: string, text: string): { [key: string]: unknown } {
    const source = starterSource() as {
      assetId: string;
      draft: { sections: { blocks: { id: string; data: { spans: unknown } }[] }[] };
    };
    source.assetId = assetId;
    const block = source.draft.sections.flatMap((section) => section.blocks).find((b) => b.id === 'intro-look-up');
    if (block === undefined) throw new Error('fixture paragraph missing');
    block.data.spans = text;
    return source;
  }

  it('admits the starter as authored_editorial, with the document and its provenance in separate tables', async () => {
    const source = starterSource();
    const result = await useCases.importScroll(source);
    expect(result).toMatchObject({ kind: 'imported', outcome: 'created', revision: 1 });
    if (result.kind !== 'imported') return;
    const stored = await rows(result.assetId);
    expect(stored.asset).toEqual({ kind: 'scroll', status: 'admitted', revision: 1 });
    expect(stored.revisions).toHaveLength(1);
    const [revision] = stored.revisions;
    expect(revision).toMatchObject({
      revision: 1,
      provenance_kind: 'authored_editorial',
      document_version: 'scroll-document.v1',
      document_sha256: result.documentSha256,
    });
    // The stored bytes pass scroll-model's admission again, and carry no internal provenance.
    expect(admitDocument(revision?.document).kind).toBe('valid');
    const document = revision?.document as { [key: string]: unknown };
    for (const internal of ['claims', 'sources', 'bindings', 'checks', 'production'])
      expect(Object.keys(document)).not.toContain(internal);
    expect(JSON.stringify(document)).not.toContain('authored-editorial');
    expect(stored.provenance).toHaveLength(1);
    expect(stored.provenance[0]?.provenance).toMatchObject({
      schemaVersion: 'scroll-provenance.v1',
      production: { kind: 'authored-editorial', reference: 'editorial-starter-sky-blue' },
      documentSha256: result.documentSha256,
    });
    const facts = await database.db
      .selectFrom('content.asset_revisions')
      .select('reading_facts')
      .where('asset_id', '=', result.assetId)
      .executeTakeFirstOrThrow();
    expect(facts.reading_facts).toMatchObject({ v: 1, measuresVersion: 'scroll-measures.v1' });
  });

  it('is idempotent: the same file is the same revision, a changed file is a new one that leaves the old untouched', async () => {
    const assetId = randomUUID();
    const first = await useCases.importScroll(
      editedSource(assetId, 'First wording of the opening paragraph, kept plain.'),
    );
    expect(first).toMatchObject({ kind: 'imported', outcome: 'created', revision: 1 });
    const again = await useCases.importScroll(
      editedSource(assetId, 'First wording of the opening paragraph, kept plain.'),
    );
    expect(again).toMatchObject({ kind: 'imported', outcome: 'unchanged', revision: 1 });
    expect((await rows(assetId)).revisions).toHaveLength(1);
    const before = (await rows(assetId)).revisions[0];

    const changed = await useCases.importScroll(
      editedSource(assetId, 'Second wording of the opening paragraph, kept plain.'),
    );
    expect(changed).toMatchObject({ kind: 'imported', outcome: 'revised', revision: 2 });
    const after = await rows(assetId);
    expect(after.asset?.revision).toBe(2);
    expect(after.revisions.map((revision) => revision.revision)).toEqual([1, 2]);
    expect(after.provenance.map((entry) => entry.revision)).toEqual([1, 2]);
    // Revision 1 is immutable: its bytes and hash are exactly what they were.
    expect(after.revisions[0]).toEqual(before);
    expect(after.revisions[0]?.document_sha256).not.toBe(after.revisions[1]?.document_sha256);
    // The revision number is part of the integrity hash: the document says which revision it is.
    expect((after.revisions[1]?.document as { revision: number }).revision).toBe(2);
  });

  it('serialises concurrent imports of one asset: one creates it, the other finds it', async () => {
    const assetId = randomUUID();
    const source = editedSource(assetId, 'Concurrent import of one and the same file.');
    const [a, b] = await Promise.all([useCases.importScroll(source), useCases.importScroll(source)]);
    expect([a, b].map((result) => (result.kind === 'imported' ? result.outcome : result.reason)).sort()).toEqual([
      'created',
      'unchanged',
    ]);
    expect((await rows(assetId)).revisions).toHaveLength(1);
  });

  it('refuses a file that is not an editorial source, with stable codes and paths and no text', async () => {
    const result = await useCases.importScroll({
      schemaVersion: 'editorial-scroll.v1',
      assetId: 'not-a-uuid',
      secret: 'canary-source-text',
    });
    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') return;
    expect(result.reason).toBe('source_invalid');
    expect(JSON.stringify(result)).not.toContain('canary-source-text');
    for (const issue of result.issues) expect(Object.keys(issue).sort()).toEqual(['code', 'path']);
  });

  it('refuses a draft that breaks admission (a number bound to no claim) and writes nothing', async () => {
    const assetId = randomUUID();
    const result = await useCases.importScroll(
      editedSource(assetId, 'The sky has 7 colours and no claim stands behind that number.'),
    );
    expect(result).toMatchObject({ kind: 'refused', reason: 'compile_refused', stage: 'evidence' });
    if (result.kind === 'refused') expect(result.issues.map((issue) => issue.code)).toContain('number_unbound');
    expect((await rows(assetId)).asset).toBeUndefined();
    expect((await rows(assetId)).revisions).toEqual([]);
  });

  it('refuses an asset ID that already names something that is not a Scroll, or was withdrawn', async () => {
    const reel = await seedAsset(database.db);
    expect(
      await useCases.importScroll(editedSource(reel.assetId, "A Scroll cannot take a Reel's identity.")),
    ).toMatchObject({
      kind: 'refused',
      reason: 'asset_is_not_a_scroll',
    });
    const assetId = randomUUID();
    await useCases.importScroll(editedSource(assetId, 'Soon to be withdrawn, and never admitted again.'));
    await sql`update content.assets set status = 'withdrawn' where id = ${assetId}`.execute(database.db);
    expect(
      await useCases.importScroll(editedSource(assetId, 'Soon to be withdrawn, and never admitted again.')),
    ).toMatchObject({
      kind: 'refused',
      reason: 'asset_withdrawn',
    });
  });

  it('keeps shared content out of personal storage: no universe or account column on the content tables', async () => {
    const columns = await sql<{ table_name: string; column_name: string }>`
      select table_name, column_name from information_schema.columns
      where table_schema = 'content' and (column_name = 'universe_id' or column_name like '%account_id')`.execute(
      database.db,
    );
    expect(columns.rows).toEqual([]);
  });
});
