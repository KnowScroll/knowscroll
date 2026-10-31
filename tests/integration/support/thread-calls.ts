/** Labelled fixtures for "Call it together" tests: admitted v2 Scrolls with one authored call, written straight to the content tables. */
import { createHash, randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { callsOf, type ScrollDocumentV2 } from '@knowscroll/scroll-model';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { assembleScrollV2 } from '../../../packages/scroll-model/src/producer/v2/assemble.js';
import { authoredV2, PUBLICATION_V2, recipeV2 } from '../../../packages/scroll-model/src/test-support/v2-fixtures.js';
import type { SeededAsset } from './thread-fixtures.js';

/** What a test sets on the first Call it of a seeded Scroll. */
export interface CallFixture {
  readonly prompt: string;
  readonly options: readonly string[];
  /** Zero-based index of the right option. */
  readonly answer: number;
  readonly explain: string;
  readonly twist: string;
  /** The authored common wrong guess; by default option 1, with a source a person has reviewed. */
  readonly guess?: { readonly option: number; readonly reviewed: boolean };
}

/** The label of the source the fixture's authored common guess names. */
export const GUESS_SOURCE = 'CI fixture source';

export const TIDES_CALL: CallFixture = {
  prompt: 'CI fixture question: when are tides biggest?',
  options: ['CI full and new moon', 'CI half moon', 'CI always the same'],
  answer: 0,
  explain: 'CI fixture explanation: spring tides come at full and new moon.',
  twist: 'CI fixture twist: half moon gives the smaller neap tides.',
};

export interface SeededCallScroll extends SeededAsset {
  readonly call: CallFixture;
}

/**
 * A v2 Scroll (the labelled assembled fixture) whose first Call it is `call`, admitted under a fresh asset ID.
 * The stored document is read the way the server reads it, structure and bounds (the integrity hash is not
 * recomputed on that path), so only the call's own words change.
 */
export async function seedCallScroll(db: Kysely<Database>, call: CallFixture = TIDES_CALL): Promise<SeededCallScroll> {
  const assetId = randomUUID();
  await db
    .insertInto('content.assets')
    .values({ id: assetId, revision: 1, kind: 'scroll', status: 'admitted' })
    .execute();
  await insertCallRevision(db, assetId, 1, call);
  return { assetId, call };
}

/**
 * A later revision of a seeded Scroll with its own first Call it, released the way a correction is: its row, and the Scroll
 * pointing at it. The earlier revisions stay as they are (revisions are immutable), so a thread that called on revision 1
 * can still read what it called on.
 */
export async function seedCallRevision(
  db: Kysely<Database>,
  assetId: string,
  revision: number,
  call: CallFixture,
): Promise<void> {
  await insertCallRevision(db, assetId, revision, call);
  await db.updateTable('content.assets').set({ revision }).where('id', '=', assetId).execute();
}

async function insertCallRevision(
  db: Kysely<Database>,
  assetId: string,
  revision: number,
  call: CallFixture,
): Promise<void> {
  const assembled = assembleScrollV2(authoredV2('plain'), PUBLICATION_V2, recipeV2('plain'));
  if (assembled.kind !== 'assembled') throw new Error('CI v2 fixture did not assemble');
  const document = JSON.parse(JSON.stringify(assembled.document)) as ScrollDocumentV2;
  const first = callsOf(document).find((stop) => stop.kind === 'call_it');
  if (first === undefined) throw new Error('CI v2 fixture has no Call it');
  if (first.kind !== 'call_it' || first.commonGuess === undefined) throw new Error('CI v2 fixture has no common guess');
  // The authored common guess, as a recipe would set it: a wrong option, with its source.
  const wanted = call.guess ?? { option: call.answer === 1 ? 0 : 1, reviewed: true };
  // A stop's common guess names the same source as the Scroll's misconception (the validator requires it).
  const source = { label: GUESS_SOURCE, reviewed: wanted.reviewed };
  if (document.misconception.kind !== 'myth') throw new Error('CI v2 fixture has no myth');
  document.misconception.source = source;
  const guess = { option: wanted.option, source };
  Object.assign(first, {
    prompt: call.prompt,
    options: [...call.options],
    answer: call.answer,
    explain: call.explain,
    twist: call.twist,
    commonGuess: guess,
  });
  Object.assign(document, { assetId, revision });
  await db
    .insertInto('content.asset_revisions')
    .values({
      asset_id: assetId,
      revision,
      provenance_kind: 'authored_editorial',
      document_version: 'scroll-document.v2',
      document: JSON.stringify(document),
      document_sha256: createHash('sha256').update(JSON.stringify(document)).digest('hex'),
      explanation_unit_id: `ci-call-${assetId.slice(0, 8)}-${String(revision)}`,
      language: 'en',
      title: document.title,
      reading_facts: '{}',
    })
    .execute();
}
