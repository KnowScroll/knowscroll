/** Labelled fixtures for content-thread tests: admitted Reels and Scrolls written straight to the content tables. */
import { createHash, randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { ScrollDocument } from '@knowscroll/scroll-model';
import { admitDocument } from '@knowscroll/scroll-model/admission';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { seal } from '../../../packages/scroll-model/src/test-support/arbitraries.js';
import { fixture, type FixtureName } from '../../../packages/scroll-model/src/test-support/fixtures.js';
import type { FixturePerson } from './fixtures.js';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export interface SeededAsset {
  readonly assetId: string;
}

function reelDocument(assetId: string, revision: number, durationMs: number, title: string) {
  const digest = sha256(`${assetId}:${String(revision)}`);
  return {
    schemaVersion: 'reel-document.v1',
    assetId,
    revision,
    title,
    summary: `Summary of ${title}`,
    language: 'en',
    truthLabel: 'generated',
    fixture: true,
    captions: 'burned_in',
    mediaKey: `sha256/${digest.slice(0, 2)}/${digest}.mp4`,
    durationMs,
    width: 720,
    height: 1280,
  };
}

async function insertRevision(
  db: Kysely<Database>,
  assetId: string,
  revision: number,
  row: { document: unknown; documentVersion: string; documentSha256: string; title: string; unit: string },
) {
  await db
    .insertInto('content.asset_revisions')
    .values({
      asset_id: assetId,
      revision,
      provenance_kind: 'authored_editorial',
      document_version: row.documentVersion,
      document: JSON.stringify(row.document),
      document_sha256: row.documentSha256,
      explanation_unit_id: row.unit,
      language: 'en',
      title: row.title,
      reading_facts: '{}',
    })
    .execute();
  await db.updateTable('content.assets').set({ revision }).where('id', '=', assetId).execute();
}

/** An admitted Reel (CI fixture: a valid reel document, no media). */
export async function seedReel(
  db: Kysely<Database>,
  options: { readonly durationMs?: number; readonly title?: string } = {},
): Promise<SeededAsset> {
  const assetId = randomUUID();
  await db.insertInto('content.assets').values({ id: assetId, revision: 1, kind: 'reel', status: 'admitted' }).execute();
  await addReelRevision(db, assetId, 1, options);
  return { assetId };
}

export async function addReelRevision(
  db: Kysely<Database>,
  assetId: string,
  revision: number,
  options: { readonly durationMs?: number; readonly title?: string } = {},
): Promise<void> {
  const title = options.title ?? 'Fixture Reel';
  const document = reelDocument(assetId, revision, options.durationMs ?? 30_000, title);
  await insertRevision(db, assetId, revision, {
    document,
    documentVersion: 'reel-document.v1',
    documentSha256: sha256(JSON.stringify(document)),
    title,
    unit: `ci-reel-${assetId.slice(0, 8)}`,
  });
}

export interface SeededScroll extends SeededAsset {
  readonly document: ScrollDocument;
}

/** One of scroll-model's labelled fixture documents, re-sealed under a fresh asset ID and admitted. */
export async function seedScroll(db: Kysely<Database>, name: FixtureName): Promise<SeededScroll> {
  const assetId = randomUUID();
  await db.insertInto('content.assets').values({ id: assetId, revision: 1, kind: 'scroll', status: 'admitted' }).execute();
  const document = await addScrollRevision(db, assetId, 1, fixture(name).document);
  return { assetId, document };
}

/** Admits `source` as revision `revision` of an existing Scroll (a correction), sections as given. */
export async function addScrollRevision(
  db: Kysely<Database>,
  assetId: string,
  revision: number,
  source: ScrollDocument,
  sections: ScrollDocument['sections'] = source.sections,
): Promise<ScrollDocument> {
  const { sections: _sections, measures: _measures, integrity: _integrity, ...rest } = source;
  const document = seal(sections, { ...rest, assetId, revision });
  if (admitDocument(document).kind !== 'valid') throw new Error('CI scroll fixture is not admissible');
  await insertRevision(db, assetId, revision, {
    document,
    documentVersion: 'scroll-document.v1',
    documentSha256: document.integrity.sha256,
    title: document.title,
    unit: document.explanationUnitId,
  });
  return document;
}

/** Declares a series of exact first revisions: parts in the order given. */
export async function declareSeries(
  db: Kysely<Database>,
  seriesId: string,
  units: readonly { readonly assetId: string; readonly assetRevision?: number }[],
): Promise<void> {
  for (const [index, unit] of units.entries())
    await db
      .insertInto('content.series_units')
      .values({
        series_id: seriesId,
        series_revision: 1,
        part: index + 1,
        asset_id: unit.assetId,
        asset_revision: unit.assetRevision ?? 1,
        authority_reference: 'ci-thread-fixture',
      })
      .execute();
}

/** The person opened and activated this asset: their own history, which the Visited marker reads. */
export async function activateFor(db: Kysely<Database>, person: FixturePerson, assetId: string, kind: 'reel' | 'scroll') {
  await db
    .insertInto('experience.exposures')
    .values({
      universe_id: person.universeId,
      id: randomUUID(),
      asset_id: assetId,
      asset_revision: 1,
      kind,
      origin: 'direct',
      capabilities: '{}',
      command_id: randomUUID(),
      privacy_epoch: 1,
      activated_at: new Date(),
    })
    .execute();
}
