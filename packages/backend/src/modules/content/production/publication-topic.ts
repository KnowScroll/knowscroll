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
import { coverageHeadPorts } from '../adapters/coverage-store.js';
import { inAdmissionTransaction } from '../adapters/postgres-store.js';
import { admitRecipeCoverage } from '../application/admit-recipe-coverage.js';
import { validateTopics } from '../domain/discovery.js';
import { WRITER_PROMPT_VERSION } from './writer.js';
import { explanationUnitFor, parseScrollTopic, SCROLL_PRODUCTION_VERSION, TOPICS, type ScrollTopic } from './topics.js';

const ATTRIBUTION_VERSION = 'published-scroll-brief-taxonomy.v1';
const SENT_STEP = /^(primary|repair)(\.[1-9])?$/;
const AttemptIdentity = z.object({
  attemptId: z.uuid(),
  step: z.string().regex(SENT_STEP),
  state: z.enum(['succeeded', 'reconciled']),
  provider: z.literal('minimax'),
  model: z.enum(MINIMAX_MODELS),
});
/** The writer receipt records every attempt of the run, including those that sent nothing. */
const WriterReceipt = z.object({
  role: z.literal('writer'),
  kind: z.literal('proposed'),
  attemptId: z.uuid(),
  attempts: z.array(z.looseObject({ attemptId: z.uuid(), state: z.string() })).min(1),
});

/**
 * Attempts that never reached the provider (a spent quota, a paused job) cost nothing and have no
 * say over the answer: they are left out of the lineage a published Scroll must prove.
 */
export function isSentAttempt(attempt: { readonly state: string }): boolean {
  return attempt.state !== 'reserved' && attempt.state !== 'not_sent';
}

/** `primary.2` is the second try of the primary step: the logical step is what the lineage names. */
const logicalStep = (step: string): string => step.split('.')[0] ?? step;

/** A published generated revision whose job, recipe, document and writer attempts all agree. */
interface VerifiedPublication {
  readonly topic: ScrollTopic;
  readonly assetId: string;
  readonly revision: number;
}

type PublishedRevisionRow = NonNullable<Awaited<ReturnType<typeof readPublishedRevision>>>;

async function readPublishedRevision(
  tx: Transaction<Database>,
  jobId: string,
  writerRunId: string,
  generation: number,
) {
  return tx
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
}

/** The stored document and provenance are the recipe's, at the revision the job targeted. */
function matchesRecipe(row: PublishedRevisionRow, writerRunId: string) {
  const topic = parseScrollTopic(row.topic);
  if (
    topic === undefined ||
    row.asset_id !== TOPICS[topic].assetId ||
    row.revision !== row.target_revision ||
    row.explanation_unit_id !== explanationUnitFor(topic)
  )
    return undefined;
  const document = parseDocument(row.document);
  const provenance = ScrollProvenance.safeParse(row.provenance);
  if (document.kind !== 'valid' || !provenance.success) return undefined;
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
    return undefined;
  return { topic, production };
}

/** The job's single writer receipt names exactly the sent attempts the harness accounted. */
function matchesWriterAttempts(
  outcomes: unknown,
  attempts: readonly ProductionAttemptAccounting[],
  production: { readonly model: string; readonly attemptIds: readonly string[] },
): boolean {
  const identities = z.array(AttemptIdentity).min(1).max(2).safeParse(attempts.filter(isSentAttempt));
  const receipts = z.array(z.unknown()).safeParse(outcomes);
  if (!identities.success || !receipts.success) return false;
  const writers = receipts.data.filter((outcome) => z.object({ role: z.literal('writer') }).safeParse(outcome).success);
  const receipt = WriterReceipt.safeParse(writers[0]);
  const recorded = receipt.success
    ? z.array(AttemptIdentity).safeParse(receipt.data.attempts.filter(isSentAttempt))
    : undefined;
  const final = identities.data.at(-1);
  return !(
    writers.length !== 1 ||
    !receipt.success ||
    !recorded?.success ||
    final === undefined ||
    logicalStep(identities.data[0]?.step ?? '') !== 'primary' ||
    (identities.data.length === 2 && logicalStep(final.step) !== 'repair') ||
    new Set(identities.data.map((attempt) => attempt.attemptId)).size !== identities.data.length ||
    identities.data.some((attempt) => attempt.model !== production.model) ||
    receipt.data.attemptId !== final.attemptId ||
    JSON.stringify(recorded.data) !== JSON.stringify(identities.data) ||
    JSON.stringify(production.attemptIds) !== JSON.stringify(identities.data.map((attempt) => attempt.attemptId))
  );
}

/**
 * Missing, foreign or fixture lineage yields `undefined` and the revision stays without attribution:
 * attribution never borrows authority from an explanation ID.
 */
async function verifyPublication(
  tx: Transaction<Database>,
  jobId: string,
  writerRunId: string,
  generation: number,
  attempts: readonly ProductionAttemptAccounting[],
): Promise<VerifiedPublication | undefined> {
  const row = await readPublishedRevision(tx, jobId, writerRunId, generation);
  if (row === undefined || !row.claims_present || !row.writer_output_present) return undefined;
  const recipe = matchesRecipe(row, writerRunId);
  if (recipe === undefined || !matchesWriterAttempts(row.outcomes, attempts, recipe.production)) return undefined;
  return { topic: recipe.topic, assetId: row.asset_id, revision: row.revision };
}

/**
 * Records the recipe's planet as the revision's single primary topic. The 0016 revision trigger
 * already created the baseline row; this never creates metadata for a missing revision or replaces
 * conflicting authority. SQL's aggregate weight guard stays active, and the row lock serializes even
 * an idempotent projection of the same target. Returns false when existing attribution conflicts.
 */
async function attributeTopic(tx: Transaction<Database>, publication: VerifiedPublication): Promise<boolean> {
  const metadata = await tx
    .selectFrom('content.discovery_revisions')
    .select('facets')
    .where('asset_id', '=', publication.assetId)
    .where('asset_revision', '=', publication.revision)
    .forUpdate()
    .executeTakeFirst();
  if (metadata === undefined) return false;
  const attribution = { topicId: TOPICS[publication.topic].topicId, role: 'primary' as const, weight: 1 };
  validateTopics([attribution]);
  const existing = await tx
    .selectFrom('content.encounter_topics')
    .select(['topic_id', 'role', 'weight'])
    .where('asset_id', '=', publication.assetId)
    .where('asset_revision', '=', publication.revision)
    .limit(17)
    .execute();
  if (
    (metadata.facets.length !== 0 && JSON.stringify(metadata.facets) !== JSON.stringify([attribution.topicId])) ||
    existing.length > 1 ||
    existing.some((entry) => entry.topic_id !== attribution.topicId || entry.role !== 'primary' || entry.weight !== 1)
  )
    return false;
  await tx
    .insertInto('content.encounter_topics')
    .values({
      asset_id: publication.assetId,
      asset_revision: publication.revision,
      topic_id: attribution.topicId,
      role: 'primary',
      weight: 1,
    })
    .onConflict((conflict) => conflict.columns(['asset_id', 'asset_revision', 'topic_id']).doNothing())
    .execute();
  await tx
    .updateTable('content.discovery_revisions')
    .set({ facets: [attribution.topicId], attribution_version: ATTRIBUTION_VERSION })
    .where('asset_id', '=', publication.assetId)
    .where('asset_revision', '=', publication.revision)
    .execute();
  return true;
}

/** Adds a code-only receipt to the job so the operator can see why a published Scroll lacks metadata. */
async function recordGap(tx: Transaction<Database>, jobId: string, code: string): Promise<void> {
  const receipt = { role: 'checks', kind: 'published', code };
  await sql`update content.scroll_production_runs set outcomes=outcomes||${JSON.stringify([receipt])}::jsonb where id=${jobId}`.execute(
    tx,
  );
}

/**
 * Admits the recipe's facet coverage for the revision, decided by code (D-033). When the document
 * cannot be bound, the Scroll stays published and readable but unmapped, and the job's outcomes say
 * why so the operator can see the gap.
 */
async function admitCoverage(tx: Transaction<Database>, jobId: string, publication: VerifiedPublication) {
  const outcome = await inAdmissionTransaction(tx, (admission) =>
    admitRecipeCoverage(coverageHeadPorts, admission, TOPICS[publication.topic], {
      assetId: publication.assetId,
      assetRevision: publication.revision,
    }),
  );
  if (outcome.kind === 'not_admitted') await recordGap(tx, jobId, `coverage_${outcome.code}`);
}

/**
 * Unexported: attribution and coverage have no generic admission/read/backfill API. Only a newly
 * closed writer in completeWriterPublication below reaches this function, after the exact job is
 * published, and everything it writes shares that transaction. A Scroll that cannot be attributed
 * still publishes; the job's outcomes record `attribution_unverified` or `attribution_conflict`.
 */
async function projectNewPublication(
  tx: Transaction<Database>,
  jobId: string,
  writerRunId: string,
  generation: number,
  attempts: readonly ProductionAttemptAccounting[],
): Promise<void> {
  const publication = await verifyPublication(tx, jobId, writerRunId, generation, attempts);
  if (publication === undefined) return recordGap(tx, jobId, 'attribution_unverified');
  if (!(await attributeTopic(tx, publication))) return recordGap(tx, jobId, 'attribution_conflict');
  await admitCoverage(tx, jobId, publication);
}

/**
 * Private producer completion path, not an attribution port. Requires the live production scope,
 * locked writer-stage job and actual successful harness closure. Publication, topic attribution and
 * coverage share that transaction: any failure rolls the closure and domain writes back together. No
 * network, arbitrary reasoning SQL, caller-supplied closure proof or historical reconciliation.
 *
 * `attribution: 'none'` is a Scroll ordered from code (a hypothetical or a lens): it is published and
 * closed like any other and then gets no topic and no coverage, by design (D-049), so a hypothetical
 * can never grow a real-world planet.
 */
export async function completeWriterPublication(
  scope: ProductionScopeTx,
  harness: ProductionReasoningHarness,
  jobId: string,
  writerRunId: string,
  attribution: 'library' | 'none',
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
  if (attribution === 'library')
    await projectNewPublication(tx, jobId, writerRunId, scope.authority.generation, accounting.attempts);
  return true;
}
