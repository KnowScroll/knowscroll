import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import type { ScrollDocumentV2 } from '@knowscroll/scroll-model';
import { coverageHeadPorts } from '../../../packages/backend/src/modules/content/adapters/coverage-store.js';
import {
  inAdmissionTransaction,
  makeAdmissionStore,
} from '../../../packages/backend/src/modules/content/adapters/postgres-store.js';
import { attributePrimaryTopic } from '../../../packages/backend/src/modules/content/adapters/topic-attribution.js';
import { admitRecipeCoverage } from '../../../packages/backend/src/modules/content/application/admit-recipe-coverage.js';
import { codeRecipeOf } from '../../../packages/backend/src/modules/content/application/recipe-book.js';
import type { CallVerdict } from '../../../packages/backend/src/modules/content/domain/answer-check.js';
import {
  storedOrrinV2,
  type StoredOrrinV2Options,
} from '../../../packages/backend/src/modules/content/production/orrin.fixture.js';
import {
  SCROLL_PRODUCTION_V2_VERSION,
  type ScrollTopic,
} from '../../../packages/backend/src/modules/content/production/topics.js';
import { WRITER_V2_PROMPT_VERSION } from '../../../packages/backend/src/modules/content/production/writer-v2-version.js';

/**
 * Stored `scroll-document.v2` revisions for the tests of what still READS them (#815). Nothing produces a v2 Scroll any more, but stage
 * and main still store and serve the ones the v2 writer made, so serving, reading facts, coverage, the review gate, the release policy
 * and the checks are tested on a revision that was written the way the v2 production job wrote it: the revision, its provenance and
 * reading facts, the held review, the recipe's planet and coverage head, and the job's receipts. It is written through the production
 * path's own admission, attribution and coverage code and never through a writer. Labelled CI fixtures: the Scroll is the Orrin one.
 */

/** One answer check as the old job recorded it among its receipts: every call consistent at the first draft unless a test says more. */
export type RecordedCheck =
  | { readonly kind: 'checked'; readonly draft: 1 | 2; readonly verdicts: readonly CallVerdict[] }
  | { readonly kind: 'unchecked'; readonly draft: 1 | 2; readonly code: string };

export interface StoreV2Options extends Pick<
  StoredOrrinV2Options,
  'variant' | 'edit' | 'production' | 'landmark' | 'finalCall'
> {
  /** The revision number. Default: the one after the asset's latest. */
  readonly revision?: number;
  /** Held for review, as the production job stored every library v2 revision. Default `true`; `false` serves it at once. */
  readonly held?: boolean;
  /**
   * The answer checks the job's receipts hold. Default: one check at the first draft with every call consistent. `[]` stores the job with
   * no check at all (a job from before the check existed).
   */
  readonly checks?: readonly RecordedCheck[];
  /** Whether the recipe's planet is attributed and its coverage decided, as publication did for a library recipe. Default `true`. */
  readonly projected?: boolean;
}

/** What a stored revision is: where it sits, and the document the way a reader reads it. */
export interface StoredV2 {
  readonly key: ScrollTopic;
  readonly assetId: string;
  readonly revision: number;
  readonly document: ScrollDocumentV2;
  /** The id of the job row that records it. */
  readonly jobId: string;
}

/** The checks a job records by default: the calls of the revision are all consistent. */
function consistentChecks(document: ScrollDocumentV2): readonly RecordedCheck[] {
  const verdicts = document.stops.flatMap((stop): CallVerdict[] =>
    stop.kind === 'read' ? [] : [{ id: stop.id, consistent: true }],
  );
  return [{ kind: 'checked', draft: 1, verdicts }];
}

/** The take after the highest the recipe has at the v2 production version. */
async function nextTake(db: Kysely<Database>, key: ScrollTopic): Promise<number> {
  const { rows } = await sql<{ take: number }>`select coalesce(max(take), 0)::integer + 1 as take
    from content.scroll_production_runs where topic = ${key} and policy_version = ${SCROLL_PRODUCTION_V2_VERSION}`.execute(
    db,
  );
  return rows[0]!.take;
}

/**
 * Stores a v2 revision of a library recipe, the way the v2 production job stored it, and returns where it is. The first revision creates
 * the asset (held, so no read sees it, when `held`); a later revision of the same asset is held beside the served one, or becomes the served
 * one when not held.
 */
export async function storeV2(db: Kysely<Database>, key: ScrollTopic, options: StoreV2Options = {}): Promise<StoredV2> {
  const recipe = codeRecipeOf(key);
  if (recipe === undefined) throw new Error(`CI_STORE_V2_NEEDS_A_CODE_RECIPE:${key}`);
  const held = options.held ?? true;
  const jobId = randomUUID();
  const take = await nextTake(db, key);
  const stored = await db.transaction().execute((trx) =>
    inAdmissionTransaction(trx, async (admission) => {
      const store = makeAdmissionStore(db);
      const asset = await store.lockAsset(admission, recipe.assetId);
      const latest = asset.kind === 'absent' ? 0 : asset.latestRevision;
      const revision = options.revision ?? latest + 1;
      const compiled = storedOrrinV2({
        assetId: recipe.assetId,
        explanationUnitId: recipe.explanationUnitId,
        revision,
        ...(options.variant === undefined ? {} : { variant: options.variant }),
        ...(options.edit === undefined ? {} : { edit: options.edit }),
        ...(options.landmark === undefined ? {} : { landmark: options.landmark }),
        ...(options.finalCall === undefined ? {} : { finalCall: options.finalCall }),
        ...(options.production === undefined
          ? { production: { runId: jobId, attemptIds: [randomUUID()], model: 'MiniMax-M3.1-Flash' } }
          : { production: options.production }),
      });
      await store.storeRevision(admission, {
        assetId: recipe.assetId,
        revision,
        provenanceKind: 'generated',
        compiled,
        createsAsset: asset.kind === 'absent',
        ...(held ? { held } : {}),
      });
      const document = compiled.document as unknown as ScrollDocumentV2;
      const checks = options.checks ?? consistentChecks(document);
      await sql`insert into content.scroll_production_runs
        (id, topic, policy_version, take, target_revision, scope_generation, state, writer_run_id, research, claims, writer_output,
         outcomes, asset_id, asset_revision, completed_at)
        values (${jobId}::uuid, ${key}, ${SCROLL_PRODUCTION_V2_VERSION}, ${take}, ${revision}, 1, 'published', ${randomUUID()}::uuid,
          '[]'::jsonb, ${JSON.stringify(compiled.provenance['claims'])}::jsonb, '{}'::jsonb,
          ${JSON.stringify([
            { role: 'writer', kind: 'published', promptVersion: WRITER_V2_PROMPT_VERSION },
            ...checks.map((check) => ({ role: 'answer_check', ...check })),
          ])}::jsonb,
          ${recipe.assetId}::uuid, ${revision}, now())`.execute(trx);
      if (options.projected !== false) {
        const attributed = await attributePrimaryTopic(trx, {
          assetId: recipe.assetId,
          revision,
          topicId: recipe.topicId,
          version: 'published-scroll-brief-taxonomy.v1',
        });
        if (!attributed) throw new Error('CI_STORE_V2_ATTRIBUTION_CONFLICT');
        const coverage = await admitRecipeCoverage(coverageHeadPorts, admission, recipe, {
          assetId: recipe.assetId,
          assetRevision: revision,
        });
        if (coverage.kind !== 'admitted') throw new Error(`CI_STORE_V2_COVERAGE_REFUSED:${coverage.code}`);
      }
      return { revision, document };
    }),
  );
  return { key, assetId: recipe.assetId, revision: stored.revision, document: stored.document, jobId };
}
