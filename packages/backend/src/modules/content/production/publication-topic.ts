import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { parseDocument } from '@knowscroll/scroll-model';
import { ScrollProvenance } from '@knowscroll/scroll-model/internal';
import { MINIMAX_MODELS } from '../../../infrastructure/config/index.js';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { productionTransactionOf } from '../../../infrastructure/postgres/index.js';
import type {
  ProductionAttemptAccounting,
  ProductionReasoningHarness,
  ProductionScopeTx,
} from '../../../reasoning/public.js';
import { validateTopics } from '../domain/discovery.js';
import { WRITER_PROMPT_VERSION } from './roles.js';
import { explanationUnitFor, parseScrollTopic, SCROLL_PRODUCTION_VERSION, TOPICS } from './topics.js';

const ATTRIBUTION_VERSION = 'published-scroll-brief-taxonomy.v1';
const AttemptIdentity = z.object({
  attemptId: z.uuid(),
  step: z.enum(['primary', 'repair']),
  state: z.enum(['succeeded', 'reconciled']),
  provider: z.literal('minimax'),
  model: z.enum(MINIMAX_MODELS),
});
const WriterReceipt = z.object({
  role: z.literal('writer'),
  kind: z.literal('proposed'),
  attemptId: z.uuid(),
  attempts: z.array(AttemptIdentity).min(1).max(2),
});

/**
 * Unexported: attribution has no generic admission/read/backfill API. Only a newly closed writer
 * in completeWriterPublication below reaches this function, after the exact job is published.
 * Missing/foreign/fixture lineage stays unknown; it never borrows authority from an explanation ID.
 */
async function projectNewPublication(
  tx: Transaction<Database>,
  jobId: string,
  writerRunId: string,
  generation: number,
  attempts: readonly ProductionAttemptAccounting[],
): Promise<void> {
  const row = await tx
    .selectFrom('content.scroll_production_runs as job')
    .innerJoin('content.asset_revisions as revision', (join) =>
      join.onRef('revision.asset_id', '=', 'job.asset_id').onRef('revision.revision', '=', 'job.asset_revision'),
    )
    .innerJoin('content.assets as asset', 'asset.id', 'revision.asset_id')
    .innerJoin('content.asset_provenance as provenance', (join) =>
      join
        .onRef('provenance.asset_id', '=', 'revision.asset_id')
        .onRef('provenance.revision', '=', 'revision.revision'),
    )
    .select([
      'job.topic',
      'job.target_revision',
      sql<boolean>`job.claims is not null`.as('claims_present'),
      sql<boolean>`job.writer_output is not null`.as('writer_output_present'),
      'job.outcomes',
      'revision.asset_id',
      'revision.revision',
      'revision.explanation_unit_id',
      'revision.document_sha256',
      'revision.document_version',
      'provenance.provenance_version',
      'revision.document',
      'provenance.provenance',
    ])
    .where('job.id', '=', jobId)
    .where('job.state', '=', 'published')
    .where('job.policy_version', '=', SCROLL_PRODUCTION_VERSION)
    .where('job.writer_run_id', '=', writerRunId)
    .where('job.scope_generation', '=', generation)
    .where('revision.provenance_kind', '=', 'generated')
    .where('asset.kind', '=', 'scroll')
    .where('asset.status', '=', 'admitted')
    .whereRef('asset.revision', '=', 'revision.revision')
    .executeTakeFirst();
  if (row === undefined || !row.claims_present || !row.writer_output_present) return;
  const topic = parseScrollTopic(row.topic);
  if (
    topic === undefined ||
    row.asset_id !== TOPICS[topic].assetId ||
    row.revision !== row.target_revision ||
    row.explanation_unit_id !== explanationUnitFor(topic)
  )
    return;
  const document = parseDocument(row.document);
  const provenance = ScrollProvenance.safeParse(row.provenance);
  if (document.kind !== 'valid' || !provenance.success) return;
  const production = provenance.data.production;
  if (
    document.document.schemaVersion !== row.document_version ||
    provenance.data.schemaVersion !== row.provenance_version ||
    document.document.assetId !== row.asset_id ||
    document.document.revision !== row.revision ||
    document.document.explanationUnitId !== row.explanation_unit_id ||
    document.document.integrity.sha256 !== row.document_sha256 ||
    provenance.data.assetId !== row.asset_id ||
    provenance.data.revision !== row.revision ||
    provenance.data.documentSha256 !== row.document_sha256 ||
    production.kind !== 'model' ||
    production.runId !== writerRunId ||
    production.promptVersion !== WRITER_PROMPT_VERSION
  )
    return;
  const identities = z.array(AttemptIdentity).min(1).max(2).safeParse(attempts);
  const outcomes = z.array(z.unknown()).safeParse(row.outcomes);
  if (!identities.success || !outcomes.success) return;
  const writers = outcomes.data.filter((outcome) => z.object({ role: z.literal('writer') }).safeParse(outcome).success);
  const receipt = WriterReceipt.safeParse(writers[0]);
  const final = identities.data.at(-1);
  if (
    writers.length !== 1 ||
    !receipt.success ||
    final === undefined ||
    identities.data[0]?.step !== 'primary' ||
    (identities.data.length === 2 && final.step !== 'repair') ||
    new Set(identities.data.map((attempt) => attempt.attemptId)).size !== identities.data.length ||
    identities.data.some((attempt) => attempt.model !== production.model) ||
    receipt.data.attemptId !== final.attemptId ||
    JSON.stringify(receipt.data.attempts) !== JSON.stringify(identities.data) ||
    JSON.stringify(production.attemptIds) !== JSON.stringify(identities.data.map((attempt) => attempt.attemptId))
  )
    return;

  // The 0016 revision trigger already created this exact baseline row. Never create metadata for
  // a missing revision or replace conflicting authority. SQL's existing aggregate weight guard
  // remains active; the row lock serializes even an idempotent projection of the same target.
  const metadata = await tx
    .selectFrom('content.discovery_revisions')
    .select('facets')
    .where('asset_id', '=', row.asset_id)
    .where('asset_revision', '=', row.revision)
    .forUpdate()
    .executeTakeFirst();
  if (metadata === undefined) return;
  const attribution = { topicId: TOPICS[topic].topicId, role: 'primary' as const, weight: 1 };
  validateTopics([attribution]);
  const existing = await tx
    .selectFrom('content.encounter_topics')
    .select(['topic_id', 'role', 'weight'])
    .where('asset_id', '=', row.asset_id)
    .where('asset_revision', '=', row.revision)
    .limit(17)
    .execute();
  if (
    (metadata.facets.length !== 0 && JSON.stringify(metadata.facets) !== JSON.stringify([attribution.topicId])) ||
    existing.length > 1 ||
    existing.some((entry) => entry.topic_id !== attribution.topicId || entry.role !== 'primary' || entry.weight !== 1)
  )
    return;
  await tx
    .insertInto('content.encounter_topics')
    .values({
      asset_id: row.asset_id,
      asset_revision: row.revision,
      topic_id: attribution.topicId,
      role: 'primary',
      weight: 1,
    })
    .onConflict((conflict) => conflict.columns(['asset_id', 'asset_revision', 'topic_id']).doNothing())
    .execute();
  await tx
    .updateTable('content.discovery_revisions')
    .set({ facets: [attribution.topicId], attribution_version: ATTRIBUTION_VERSION })
    .where('asset_id', '=', row.asset_id)
    .where('asset_revision', '=', row.revision)
    .execute();
}

/**
 * Private producer completion path, not an attribution port. Requires the live production scope,
 * locked writer-stage job and actual successful harness closure. Publication and this projection
 * share that transaction: any failure rolls the closure and domain writes back together. No
 * network, arbitrary reasoning SQL, caller-supplied closure proof or historical reconciliation.
 */
export async function completeWriterPublication(
  scope: ProductionScopeTx,
  harness: ProductionReasoningHarness,
  jobId: string,
  writerRunId: string,
  publish: () => Promise<void>,
): Promise<boolean> {
  const tx = productionTransactionOf(scope);
  const job = await tx
    .selectFrom('content.scroll_production_runs')
    .select('id')
    .where('id', '=', jobId)
    .where('state', '=', 'writer')
    .where('policy_version', '=', SCROLL_PRODUCTION_VERSION)
    .where('scope_generation', '=', scope.authority.generation)
    .where('writer_run_id', '=', writerRunId)
    .forUpdate()
    .executeTakeFirst();
  if (job === undefined) return false;
  const accounting = await harness.readProductionRunAccounting(scope, writerRunId);
  if (accounting.kind !== 'accounted') return false;
  if ((await harness.closeProductionRun(scope, { runId: writerRunId, state: 'completed' })) !== 'closed') return false;
  await publish();
  await projectNewPublication(tx, jobId, writerRunId, scope.authority.generation, accounting.attempts);
  return true;
}
