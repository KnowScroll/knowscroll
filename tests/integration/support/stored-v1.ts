import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql, type Kysely } from 'kysely';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { admitDocument } from '@knowscroll/scroll-model';
import { compileDraft, type DraftProvenance } from '@knowscroll/scroll-model/producer';
import { readingFactsOf } from '../../../packages/backend/src/modules/content/adapters/scroll-compiler.js';
import { coverageHeadPorts } from '../../../packages/backend/src/modules/content/adapters/coverage-store.js';
import {
  inAdmissionTransaction,
  makeAdmissionStore,
} from '../../../packages/backend/src/modules/content/adapters/postgres-store.js';
import { attributePrimaryTopic } from '../../../packages/backend/src/modules/content/adapters/topic-attribution.js';
import { admitRecipeCoverage } from '../../../packages/backend/src/modules/content/application/admit-recipe-coverage.js';
import { codeRecipeOf } from '../../../packages/backend/src/modules/content/application/recipe-book.js';
import type { CompileOutcome } from '../../../packages/backend/src/modules/content/application/ports.js';
import {
  libraryIdentity,
  type PublicationIdentity,
} from '../../../packages/backend/src/modules/content/production/publication-identity.js';
import {
  SCROLL_PRODUCTION_VERSION,
  type ScrollTopic,
} from '../../../packages/backend/src/modules/content/production/topics.js';
import { WRITER_PROMPT_VERSION } from '../../../packages/backend/src/modules/content/production/writer-v1-version.js';

/**
 * Stored `scroll-document.v1` revisions of library recipes for the tests of what still READS them (#818). Nothing produces a v1 Scroll any
 * more, but stage and main still store and serve the ones the v1 writer made, so serving, reading facts, coverage, keep, Talk, the
 * review gate and the release policy are tested on a revision stored the way the v1 production job stored it: the revision, its private
 * provenance (kind `generated`, a model production record) and reading facts, the recipe's planet and coverage head, and the job's receipts. It is
 * written through the production path's own admission, attribution and coverage code and never through a writer. A labelled CI fixture: the
 * Scroll is scroll-model's `spring-neap-tides` fixture (its draft and its two claims), compiled under the recipe's own identity.
 */

const producerFixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(new URL(`../../../packages/scroll-model/fixtures/producer/${name}`, import.meta.url), 'utf8'),
  );

export interface StoreV1Options {
  /** The revision number. Default: the one after the asset's latest. */
  readonly revision?: number;
  /** Held for review. Default `false`: the v1 job published a library Scroll straight to admitted. */
  readonly held?: boolean;
  /** Whether the recipe's planet is attributed and its coverage decided, as publication did for a library recipe. Default `true`. */
  readonly projected?: boolean;
}

/** What a stored revision is: where it sits. */
export interface StoredV1 {
  readonly key: ScrollTopic;
  readonly assetId: string;
  readonly revision: number;
  /** The id of the job row that records it. */
  readonly jobId: string;
}

/** The v1 compile of the fixture Scroll under a recipe's identity and a model production record, in the shape admission stores. */
function compileV1(
  identity: PublicationIdentity,
  revision: number,
  production: { readonly runId: string; readonly attemptIds: readonly string[]; readonly model: string },
): Extract<CompileOutcome, { kind: 'compiled' }> {
  const base = producerFixture('spring-neap-tides.provenance.json') as DraftProvenance;
  const provenance: DraftProvenance = {
    ...base,
    publication: {
      ...base.publication,
      assetId: identity.assetId,
      revision,
      explanationUnitId: identity.explanationUnitId,
      kicker: identity.kicker,
      framing: identity.framing,
    },
    production: {
      kind: 'model',
      runId: production.runId,
      attemptIds: [...production.attemptIds],
      model: production.model,
      promptVersion: WRITER_PROMPT_VERSION,
    },
  };
  const compiled = compileDraft(producerFixture('spring-neap-tides.draft.json'), provenance);
  if (compiled.kind !== 'compiled') throw new Error(`CI_STORE_V1_COMPILE_REFUSED:${JSON.stringify(compiled.issues)}`);
  const stored = JSON.parse(JSON.stringify(compiled.document)) as { readonly [key: string]: unknown };
  const admitted = admitDocument(stored);
  if (admitted.kind !== 'valid') throw new Error('CI_STORE_V1_ADMISSION_REFUSED');
  const document = admitted.document;
  return {
    kind: 'compiled',
    document: stored,
    provenance: JSON.parse(JSON.stringify(compiled.internalProvenance)) as { readonly [key: string]: unknown },
    documentVersion: document.schemaVersion,
    provenanceVersion: compiled.internalProvenance.schemaVersion,
    documentSha256: document.integrity.sha256,
    explanationUnitId: document.explanationUnitId,
    language: document.language,
    title: document.title,
    readingFacts: readingFactsOf(document),
  };
}

/** The take after the highest the recipe has at the v1 production version. */
async function nextTake(db: Kysely<Database>, key: ScrollTopic): Promise<number> {
  const { rows } = await sql<{ take: number }>`select coalesce(max(take), 0)::integer + 1 as take
    from content.scroll_production_runs where topic = ${key} and policy_version = ${SCROLL_PRODUCTION_VERSION}`.execute(
    db,
  );
  return rows[0]!.take;
}

/**
 * Stores a v1 revision of a library recipe, the way the v1 production job stored it, and returns where it is. The first revision creates the
 * asset; a later revision of the same asset becomes the served one (or is held beside it, when `held`).
 */
export async function storeV1(db: Kysely<Database>, key: ScrollTopic, options: StoreV1Options = {}): Promise<StoredV1> {
  const recipe = codeRecipeOf(key);
  if (recipe === undefined) throw new Error(`CI_STORE_V1_NEEDS_A_CODE_RECIPE:${key}`);
  const held = options.held ?? false;
  const jobId = randomUUID();
  const take = await nextTake(db, key);
  const stored = await db.transaction().execute((trx) =>
    inAdmissionTransaction(trx, async (admission) => {
      const store = makeAdmissionStore(db);
      const asset = await store.lockAsset(admission, recipe.assetId);
      const latest = asset.kind === 'absent' ? 0 : asset.latestRevision;
      const revision = options.revision ?? latest + 1;
      const compiled = compileV1(libraryIdentity(recipe), revision, {
        runId: jobId,
        attemptIds: [randomUUID()],
        model: 'MiniMax-M3.1-Flash',
      });
      await store.storeRevision(admission, {
        assetId: recipe.assetId,
        revision,
        provenanceKind: 'generated',
        compiled,
        createsAsset: asset.kind === 'absent',
        ...(held ? { held } : {}),
      });
      await sql`insert into content.scroll_production_runs
        (id, topic, policy_version, take, target_revision, scope_generation, state, writer_run_id, research, claims, writer_output,
         outcomes, asset_id, asset_revision, completed_at)
        values (${jobId}::uuid, ${key}, ${SCROLL_PRODUCTION_VERSION}, ${take}, ${revision}, 1, 'published', ${randomUUID()}::uuid,
          '[]'::jsonb, ${JSON.stringify(compiled.provenance['claims'])}::jsonb, '{}'::jsonb,
          ${JSON.stringify([{ role: 'writer', kind: 'published', promptVersion: WRITER_PROMPT_VERSION }])}::jsonb,
          ${recipe.assetId}::uuid, ${revision}, now())`.execute(trx);
      if (options.projected !== false) {
        const attributed = await attributePrimaryTopic(trx, {
          assetId: recipe.assetId,
          revision,
          topicId: recipe.topicId,
          version: 'published-scroll-brief-taxonomy.v1',
        });
        if (!attributed) throw new Error('CI_STORE_V1_ATTRIBUTION_CONFLICT');
        const coverage = await admitRecipeCoverage(coverageHeadPorts, admission, recipe, {
          assetId: recipe.assetId,
          assetRevision: revision,
        });
        if (coverage.kind !== 'admitted') throw new Error(`CI_STORE_V1_COVERAGE_REFUSED:${coverage.code}`);
      }
      return revision;
    }),
  );
  return { key, assetId: recipe.assetId, revision: stored, jobId };
}

/**
 * Stores revision 1 of a Scroll made to order as the v1 job stored one (#818): the order's own asset and explanation, a model production record,
 * served at once, and no review row, since a Scroll made to order never went through the review gate. It is the revision the tests of what
 * still reads an old made-to-order Scroll use; nothing writes one any more.
 */
export async function storeV1Order(
  db: Kysely<Database>,
  order: PublicationIdentity,
): Promise<{ readonly assetId: string; readonly revision: number }> {
  const revision = 1;
  const runId = randomUUID();
  const compiled = compileV1(order, revision, { runId, attemptIds: [randomUUID()], model: 'MiniMax-M3.1-Flash' });
  await db.transaction().execute((trx) =>
    inAdmissionTransaction(trx, async (admission) => {
      await makeAdmissionStore(db).storeRevision(admission, {
        assetId: order.assetId,
        revision,
        provenanceKind: 'generated',
        compiled,
        createsAsset: true,
      });
    }),
  );
  return { assetId: order.assetId, revision };
}
