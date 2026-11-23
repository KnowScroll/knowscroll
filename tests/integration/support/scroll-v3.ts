import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Kysely } from 'kysely';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import {
  computeIntegrityV2,
  computeIntegrityV3,
  SCROLL_DOCUMENT_V2_SCHEMA_VERSION,
  SCROLL_DOCUMENT_V3_SCHEMA_VERSION,
  type ScrollDocumentV2,
  type ScrollDocumentV3,
} from '@knowscroll/scroll-model';
import { SCROLL_PROVENANCE_V3_SCHEMA_VERSION } from '@knowscroll/scroll-model/internal';
import type { WrittenScrollV3 } from '@knowscroll/scroll-model/producer';
import { fixtureReplyV3 } from '../../../packages/backend/src/modules/content/production/spike-v3/writer-v3.fixture.js';
import { textCapabilities } from './scroll.js';

/** A client that declares exactly these document schemas, with the v1 blocks the thin journey draws. */
export const capabilitiesOf = (...documentSchemas: string[]) => ({ ...textCapabilities, documentSchemas });

/** Clients of each age: one that reads every Scroll schema, one that stops at v2, one that stops at v1. */
export const v3Client = capabilitiesOf('scroll-document.v1', 'scroll-document.v2', 'scroll-document.v3');
export const v2Client = capabilitiesOf('scroll-document.v1', 'scroll-document.v2');
export const v1Client = capabilitiesOf('scroll-document.v1');

const fixtureFile = (name: string): unknown =>
  JSON.parse(
    readFileSync(new URL(`../../../packages/scroll-model/fixtures/documents/${name}.json`, import.meta.url), 'utf8'),
  );

/** Where a seeded revision goes: a new asset, or a later revision of an existing one (a correction keeps its asset). */
export interface SeedInto {
  readonly assetId: string;
  readonly revision: number;
  readonly unit: string;
}

async function insertRevision(
  db: Kysely<Database>,
  input: {
    readonly assetId: string;
    readonly revision: number;
    readonly version: string;
    readonly document: ScrollDocumentV2 | ScrollDocumentV3;
    readonly sha256: string;
    readonly unit: string;
    readonly fresh: boolean;
  },
): Promise<void> {
  const { assetId, revision } = input;
  if (input.fresh)
    await db
      .insertInto('content.assets')
      .values({ id: assetId, revision, kind: 'scroll', status: 'admitted' })
      .execute();
  await db
    .insertInto('content.asset_revisions')
    .values({
      asset_id: assetId,
      revision,
      provenance_kind: 'authored_editorial',
      document_version: input.version,
      document: JSON.stringify(input.document),
      document_sha256: input.sha256,
      explanation_unit_id: input.unit,
      language: 'en',
      title: input.document.title,
      reading_facts: '{}',
    })
    .execute();
  if (!input.fresh) await db.updateTable('content.assets').set({ revision }).where('id', '=', assetId).execute();
}

/**
 * scroll-model's labelled document v3 CI fixture, re-sealed and stored: under a fresh asset, or as a later revision of an
 * existing one. Not product content. The reading facts are empty: serving does not read them.
 */
export async function seedDocumentV3(
  db: Kysely<Database>,
  name: 'seasons-v3-ci' | 'fence-v3-ci' | 'broad-street-v3-ci',
  into: SeedInto | undefined = undefined,
): Promise<{ readonly assetId: string; readonly revision: number; readonly document: ScrollDocumentV3 }> {
  const assetId = into?.assetId ?? randomUUID();
  const revision = into?.revision ?? 1;
  const document = fixtureFile(name) as ScrollDocumentV3;
  Object.assign(document, { assetId, revision });
  document.integrity.sha256 = computeIntegrityV3(document);
  await insertRevision(db, {
    assetId,
    revision,
    version: SCROLL_DOCUMENT_V3_SCHEMA_VERSION,
    document,
    sha256: document.integrity.sha256,
    unit: into?.unit ?? `ci-v3-${assetId.slice(0, 8)}`,
    fresh: into === undefined,
  });
  return { assetId, revision, document };
}

/** The same for scroll-model's labelled v2 CI fixture. */
export async function seedDocumentV2(
  db: Kysely<Database>,
  name: 'seasons-stage-ci' | 'scale-chart-blocks-ci',
  into: SeedInto | undefined = undefined,
): Promise<{ readonly assetId: string; readonly revision: number; readonly document: ScrollDocumentV2 }> {
  const assetId = into?.assetId ?? randomUUID();
  const revision = into?.revision ?? 1;
  const document = fixtureFile(name) as ScrollDocumentV2;
  Object.assign(document, { assetId, revision });
  document.integrity.sha256 = computeIntegrityV2(document);
  await insertRevision(db, {
    assetId,
    revision,
    version: SCROLL_DOCUMENT_V2_SCHEMA_VERSION,
    document,
    sha256: document.integrity.sha256,
    unit: into?.unit ?? `ci-v2-${assetId.slice(0, 8)}`,
    fresh: into === undefined,
  });
  return { assetId, revision, document };
}

/**
 * The labelled Orrin reply in the document v3 reply shape (`WrittenScrollV3`, arm (a)): the model's answer to the production writer of a
 * stored (`gen-`) recipe, which is a document v3 recipe (#781). It cites the passages `e1` to `e8` of the Orrin page, so a test serves it
 * the research of `orrinResearchFor`. The v2 tests answered with `plainOrrin()`; this is the same invented subject in the v3 shape.
 */
export const orrinV3 = (): WrittenScrollV3 => fixtureReplyV3();

/**
 * The plan columns of a stored recipe row inserted by hand: the document v3 plan the proposal carries (migration 0124) and no v2 plan, which the
 * row's check requires. A test that produces such a row through the real job inserts these with the row, as the proposing step does.
 */
export const storedPlanColumns = (
  plan: { readonly shape: 'argument' | 'mechanism' | 'story'; readonly sections: readonly string[] } = {
    shape: 'mechanism',
    sections: ['What the layers are', 'Why they build a cone'],
  },
) => ({ scroll_v2: null, scroll_v3: JSON.stringify(plan) }) as const;

/** The formats a stored revision and its private provenance were written in, for a test that says a job wrote a document v3. */
export async function storedFormatsOf(
  db: Kysely<Database>,
  assetId: string,
  revision: number,
): Promise<{ readonly document: string; readonly provenance: string }> {
  const document = await db
    .selectFrom('content.asset_revisions')
    .select('document_version')
    .where('asset_id', '=', assetId)
    .where('revision', '=', revision)
    .executeTakeFirstOrThrow();
  const provenance = await db
    .selectFrom('content.asset_provenance')
    .select('provenance_version')
    .where('asset_id', '=', assetId)
    .where('revision', '=', revision)
    .executeTakeFirstOrThrow();
  return { document: document.document_version, provenance: provenance.provenance_version };
}

/** What `storedFormatsOf` gives for a document v3 written by the production job: `scroll-document.v3` and `scroll-provenance.v3`. */
export const V3_FORMATS = {
  document: SCROLL_DOCUMENT_V3_SCHEMA_VERSION,
  provenance: SCROLL_PROVENANCE_V3_SCHEMA_VERSION,
} as const;
