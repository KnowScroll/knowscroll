import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { coverageHeadPorts, makeAdmissionStore } from '@knowscroll/backend/modules/content/nest-providers';
import { beatsOfV3, type ScrollDocumentV3 } from '@knowscroll/scroll-model';
import { TAKEAWAY_PART_ID } from '@knowscroll/scroll-model/internal';
import { compileEditorialSourceV3 } from '../../../packages/backend/src/modules/content/adapters/scroll-compiler-v3.js';
import { admitRecipeCoverage } from '../../../packages/backend/src/modules/content/application/admit-recipe-coverage.js';
import { RECIPES } from '../../../packages/backend/src/modules/content/domain/library/index.js';
import { sentencesOfScrollV3 } from '../../../packages/backend/src/modules/content/production/library-support-v3.js';
import { documentV3Source } from './scroll.js';

/**
 * A model-written document v3 as the release policy meets it, put in place by the stores' own paths, with a labelled CI fixture in place of the
 * writer: the hand-written document v3 fixtures (invented, never product content) stored as a revision held for review, with its recipe's topic and
 * coverage, and the one thing the fixture's own passages cannot give: passages the labelled fake checker can quote for every sentence. Nothing is
 * a model's output; this proves what the release policy reads and does with a v3, never what a model would write.
 */
export interface HeldV3 {
  readonly assetId: string;
  readonly revision: number;
  readonly document: ScrollDocumentV3;
  /** The library recipe's key and its planet, the topic the revision is attributed to. */
  readonly recipe: keyof typeof RECIPES;
  readonly topicId: string;
}

export type FixtureV3 = 'fence' | 'seasons' | 'broad-street';

/**
 * Stores a fixture as revision 1 of a new asset, held for review, or as `revision` of `existing` (a correction of an asset a reader is served).
 * `topic` puts the primary topic row in place (the production job's attribution), and `coverage` the active coverage head.
 */
export async function holdV3(
  db: Kysely<Database>,
  name: FixtureV3,
  options: {
    readonly existing?: { readonly assetId: string; readonly revision: number };
    readonly topic?: boolean;
    readonly coverage?: boolean;
  } = {},
): Promise<HeldV3> {
  const source = documentV3Source(name);
  const assetId = options.existing?.assetId ?? randomUUID();
  const revision = options.existing?.revision ?? 1;
  const compiled = compileEditorialSourceV3({ ...source, assetId }, revision);
  if (compiled.kind !== 'compiled') throw new Error(`CI fixture ${name} did not compile`);
  const store = makeAdmissionStore(db);
  await store.inAdmission((tx) =>
    store.storeRevision(tx, {
      assetId,
      revision,
      provenanceKind: 'authored_editorial',
      compiled,
      createsAsset: options.existing === undefined,
      held: true,
    }),
  );
  const recipe = source['recipe'] as keyof typeof RECIPES;
  const topicId = RECIPES[recipe].topicId;
  if (options.topic !== false)
    await db
      .insertInto('content.encounter_topics')
      .values({ asset_id: assetId, asset_revision: revision, topic_id: topicId, role: 'primary', weight: 0.8 })
      .execute();
  if (options.coverage !== false)
    await store.inAdmission((tx) =>
      admitRecipeCoverage(coverageHeadPorts, tx, RECIPES[recipe], { assetId, assetRevision: revision }),
    );
  const stored = await db
    .selectFrom('content.asset_revisions')
    .select('document')
    .where('asset_id', '=', assetId)
    .where('revision', '=', revision)
    .executeTakeFirstOrThrow();
  const held = { assetId, revision, document: stored.document as ScrollDocumentV3, recipe, topicId };
  await quotablePassages(db, held);
  return held;
}

/**
 * Replaces the revision's private provenance claims by one passage for each part (a beat, an aside, a picture, the takeaway), each the words of
 * that part's own sentences, so that the labelled fake checker can quote a sentence from the passage its part cites. The title, the dek and each
 * section's title rest on the first beat's passage. The sources and the production record are the compiled ones.
 */
export async function quotablePassages(
  db: Kysely<Database>,
  held: Pick<HeldV3, 'assetId' | 'revision' | 'document'>,
): Promise<void> {
  const { document } = held;
  const parts = [
    ...beatsOfV3(document).map((beat) => beat.id),
    ...document.asides.map((aside) => aside.id),
    ...document.pictures.map((picture) => picture.id),
    TAKEAWAY_PART_ID,
  ];
  const everyPart = {
    passages: [],
    handlesOfPart: new Map(parts.map((part) => [part, ['e1']] as const)),
    cited: ['e1'],
  };
  const listed = sentencesOfScrollV3(document, everyPart);
  if (listed.kind !== 'sentences') throw new Error('CI expected sentences');
  const firstBeat = beatsOfV3(document)[0]!.id;
  const sectionOf = new Map(document.sections.map((section) => [section.id, section.beats[0]!.id]));
  const own = (part: string): string =>
    part === 'title' || part === 'dek' ? firstBeat : (sectionOf.get(part) ?? part);
  const words = new Map<string, string[]>(parts.map((part) => [part, []]));
  for (const sentence of listed.sentences) words.get(own(sentence.part))?.push(sentence.text);
  const row = await db
    .selectFrom('content.asset_provenance')
    .select('provenance')
    .where('asset_id', '=', held.assetId)
    .where('revision', '=', held.revision)
    .executeTakeFirstOrThrow();
  const provenance = row.provenance as {
    sources: { sourceId: string }[];
    claims: unknown[];
    citations: unknown[];
  };
  const sourceId = provenance.sources[0]!.sourceId;
  const claims = parts.map((part, index) => ({
    claimId: `ci-claim-${String(index + 1)}`,
    statement: `The passage a labelled CI fixture’s ${part} rests on.`,
    quote: (words.get(part) ?? []).join(' ').slice(0, 1_200),
    sourceId,
    truthState: 'documented',
  }));
  const next = {
    ...provenance,
    claims,
    citations: parts.map((part, index) => ({ partId: part, claimIds: [`ci-claim-${String(index + 1)}`] })),
  };
  await sql`update content.asset_provenance set provenance = ${JSON.stringify(next)}::jsonb
    where asset_id = ${held.assetId}::uuid and revision = ${held.revision}::integer`.execute(db);
}

/**
 * A production job's record for the revision, as the policy reads its answer check from. A document v3 has no calls, so the job's check is the empty
 * one: `checked`, no verdicts, no request (`answer-check-step.ts`). `outcomes` replaces that, to hold another record.
 */
export async function recordProductionRun(
  db: Kysely<Database>,
  held: Pick<HeldV3, 'assetId' | 'revision'>,
  outcomes: readonly unknown[] = [{ role: 'answer_check', kind: 'checked', draft: 1, verdicts: [] }],
): Promise<void> {
  await sql`insert into content.scroll_production_runs
      (id, topic, policy_version, take, target_revision, scope_generation, state, writer_run_id, outcomes, asset_id, asset_revision, completed_at)
    values (${randomUUID()}::uuid, 'seasons', ${`ci-v3-${randomUUID()}`}, 1, ${held.revision}::integer, 1, 'published', ${randomUUID()}::uuid,
      ${JSON.stringify(outcomes)}::jsonb, ${held.assetId}::uuid, ${held.revision}::integer, now())`.execute(db);
}
