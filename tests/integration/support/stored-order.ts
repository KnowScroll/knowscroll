import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql, type Kysely } from 'kysely';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { Framing, admitDocument } from '@knowscroll/scroll-model';
import { compileDraft, type DraftProvenance } from '@knowscroll/scroll-model/producer';
import { readingFactsOf } from '../../../packages/backend/src/modules/content/adapters/scroll-compiler.js';
import {
  inAdmissionTransaction,
  makeAdmissionStore,
} from '../../../packages/backend/src/modules/content/adapters/postgres-store.js';
import type { CompileOutcome } from '../../../packages/backend/src/modules/content/application/ports.js';
import { SCROLL_PRODUCTION_VERSION } from '../../../packages/backend/src/modules/content/production/topics.js';
import { WRITER_PROMPT_VERSION } from '../../../packages/backend/src/modules/content/production/writer-v1-version.js';

/**
 * The stored `scroll-document.v1` Scroll of a made-to-order key (an ask answer, a What if, Another perspective), for the tests of what still READS
 * one (#818). Nothing produces a Scroll made to order any more (the job ends `made_to_order_unavailable`), but stage and main still store and
 * serve the ones the v1 writer made, so serving, the audience gate, keep, snippets, the thread's branch standing and the order's standing are
 * tested on a revision stored the way the v1 job stored it: through admission, with generated provenance, no topic or coverage, and a published
 * job row at the order production version. Never through a writer. A labelled CI fixture: the Scroll is scroll-model's `spring-neap-tides` fixture
 * compiled under the order's own identity (its row in `content.made_to_order_scrolls`).
 */

const producerFixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(new URL(`../../../packages/scroll-model/fixtures/producer/${name}`, import.meta.url), 'utf8'),
  );

interface OrderIdentity {
  readonly asset_id: string;
  readonly explanation_unit_id: string;
  readonly kicker: string;
  readonly framing: unknown;
}

function compileOrderScroll(
  order: OrderIdentity,
  revision: number,
  production: { readonly runId: string; readonly attemptIds: readonly string[]; readonly model: string },
): Extract<CompileOutcome, { kind: 'compiled' }> {
  const base = producerFixture('spring-neap-tides.provenance.json') as DraftProvenance;
  const provenance: DraftProvenance = {
    ...base,
    publication: {
      ...base.publication,
      assetId: order.asset_id,
      revision,
      explanationUnitId: order.explanation_unit_id,
      kicker: order.kicker,
      framing: Framing.parse(order.framing),
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
  if (compiled.kind !== 'compiled')
    throw new Error(`CI_STORE_ORDER_COMPILE_REFUSED:${JSON.stringify(compiled.issues)}`);
  const stored = JSON.parse(JSON.stringify(compiled.document)) as { readonly [key: string]: unknown };
  const admitted = admitDocument(stored);
  if (admitted.kind !== 'valid') throw new Error('CI_STORE_ORDER_ADMISSION_REFUSED');
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

/**
 * Stores revision 1 of the Scroll an order (`order-…` key, its row already in `content.made_to_order_scrolls`) asks for, the way the v1 job
 * stored it, and returns where it is. The order's asset is created and admitted.
 */
export async function storeOrderScroll(
  db: Kysely<Database>,
  recipe: string,
): Promise<{ readonly assetId: string; readonly revision: number; readonly jobId: string }> {
  const order = (
    await sql<OrderIdentity>`select asset_id, explanation_unit_id, kicker, framing
      from content.made_to_order_scrolls where recipe = ${recipe}`.execute(db)
  ).rows[0];
  if (order === undefined) throw new Error(`CI_STORE_ORDER_NO_ORDER:${recipe}`);
  const jobId = randomUUID();
  const take = (
    await sql<{ take: number }>`select coalesce(max(take), 0)::integer + 1 as take
      from content.scroll_production_runs where topic = ${recipe} and policy_version = ${SCROLL_PRODUCTION_VERSION}`.execute(
      db,
    )
  ).rows[0]!.take;
  const revision = await db.transaction().execute((trx) =>
    inAdmissionTransaction(trx, async (admission) => {
      const store = makeAdmissionStore(db);
      const asset = await store.lockAsset(admission, order.asset_id);
      const next = asset.kind === 'absent' ? 1 : asset.latestRevision + 1;
      const compiled = compileOrderScroll(order, next, {
        runId: jobId,
        attemptIds: [randomUUID()],
        model: 'MiniMax-M3.1-Flash',
      });
      await store.storeRevision(admission, {
        assetId: order.asset_id,
        revision: next,
        provenanceKind: 'generated',
        compiled,
        createsAsset: asset.kind === 'absent',
      });
      await sql`insert into content.scroll_production_runs
        (id, topic, policy_version, take, target_revision, scope_generation, state, writer_run_id, research, claims, writer_output,
         outcomes, asset_id, asset_revision, completed_at)
        values (${jobId}::uuid, ${recipe}, ${SCROLL_PRODUCTION_VERSION}, ${take}, ${next}, 1, 'published', ${randomUUID()}::uuid,
          '[]'::jsonb, ${JSON.stringify(compiled.provenance['claims'])}::jsonb, '{}'::jsonb,
          ${JSON.stringify([{ role: 'writer', kind: 'published', promptVersion: WRITER_PROMPT_VERSION }])}::jsonb,
          ${order.asset_id}::uuid, ${next}, now())`.execute(trx);
      return next;
    }),
  );
  return { assetId: order.asset_id, revision, jobId };
}
