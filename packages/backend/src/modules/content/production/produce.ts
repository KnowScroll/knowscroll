import type { Kysely } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { productionTransactionOf } from '../../../infrastructure/postgres/index.js';
import {
  fetchResearchPage,
  ResearchRefusal,
  type ResearchPage,
} from '../../../infrastructure/research/public-pages.js';
import type {
  ProductionAuthority,
  ProductionReasoningHarness,
  ProposeOutcome,
  WithProductionScope,
} from '../../../reasoning/public.js';
import { inAdmissionTransaction, makeAdmissionStore } from '../adapters/postgres-store.js';
import { type ClaimPackage, claimsRole, compileGeneratedDraft, generatedProvenance, writerRole } from './roles.js';
import { productionStore, type ProductionRow } from './store.js';
import type { ProduceScrollResult, RoleReceipt } from './types.js';
import { REQUEST_BOUND_PER_TOPIC, SCROLL_PRODUCTION_VERSION, TOPICS, type ScrollTopic } from './topics.js';

export interface ProduceScrollDependencies {
  readonly db: Kysely<Database>;
  readonly authority: ProductionAuthority;
  readonly withScope: WithProductionScope;
  readonly harness: ProductionReasoningHarness;
  readonly model: string;
  readonly research?: (url: string) => Promise<ResearchPage>;
}
function receipt<T>(role: 'claims' | 'writer', result: ProposeOutcome<T>): RoleReceipt {
  return {
    role,
    kind: result.kind,
    ...('attemptId' in result && result.attemptId !== undefined ? { attemptId: result.attemptId } : {}),
    ...('reason' in result ? { code: result.reason } : {}),
    ...('code' in result ? { code: result.code } : {}),
    ...(result.kind === 'proposed'
      ? {
          repaired: result.repaired,
          inputTokens: result.usage.inputTokens ?? undefined,
          outputTokens: result.usage.outputTokens ?? undefined,
        }
      : {}),
  };
}
function summary(row: ProductionRow): ProduceScrollResult {
  return {
    outcome:
      row.state === 'published' || row.state === 'rejected' || row.state === 'unknown' ? row.state : 'in_progress',
    requestBound: REQUEST_BOUND_PER_TOPIC,
    runId: row.id,
    ...(row.asset_id === null ? {} : { assetId: row.asset_id, revision: row.asset_revision ?? undefined }),
    attempts: row.outcomes,
  };
}
/**
 * Produce one versioned, nonpersonal Scroll: reserve a unique topic/version once, freeze public
 * research, run claims then writer (one repair each), and atomically close/apply publication under
 * the production root. No network wait holds a transaction. A repeated command reports its prior
 * terminal outcome; --resume continues the same frozen stages and harness ledger after a crash.
 * Unknown attempts halt. Scope revocation prevents applying even a valid provider answer.
 */
export function makeProduceScroll(deps: ProduceScrollDependencies) {
  const store = productionStore(deps.db);
  const admission = makeAdmissionStore(deps.db);
  return async (
    topic: ScrollTopic,
    dryRun: boolean,
    signal: AbortSignal,
    resume = false,
  ): Promise<ProduceScrollResult> => {
    if (dryRun) return { outcome: 'dry_run', requestBound: REQUEST_BOUND_PER_TOPIC };
    const reserved = await deps.withScope(deps.authority, (scope) =>
      store.create(productionTransactionOf(scope), topic, deps.authority.generation),
    );
    if (reserved.kind !== 'entered') return { outcome: 'scope_refused', requestBound: REQUEST_BOUND_PER_TOPIC };
    const { row, created } = reserved.value;
    if (!created && (!resume || ['published', 'rejected', 'unknown'].includes(row.state))) return summary(row);
    if (row.scope_generation !== deps.authority.generation)
      return { outcome: 'scope_refused', requestBound: REQUEST_BOUND_PER_TOPIC, runId: row.id };
    const run = (id: string, purpose: string) => ({
      id,
      authority: deps.authority,
      ownerModule: 'content',
      purpose,
      policyVersion: SCROLL_PRODUCTION_VERSION,
    });
    const receipts: RoleReceipt[] = [];
    const reject = async (
      state: 'rejected' | 'unknown',
      codes: readonly string[],
      runId?: string,
    ): Promise<ProduceScrollResult> => {
      const closed = await deps.withScope(deps.authority, async (scope) => {
        if (runId !== undefined && state !== 'unknown')
          await deps.harness.closeProductionRun(scope, { runId, state: 'failed' });
        await store.finish(productionTransactionOf(scope), row.id, state, [
          ...receipts,
          ...codes.slice(0, 32).map((code) => ({ role: 'checks' as const, kind: state, code })),
        ]);
      });
      return {
        outcome: closed.kind === 'entered' ? state : 'scope_refused',
        requestBound: REQUEST_BOUND_PER_TOPIC,
        runId: row.id,
        codes,
        attempts: receipts,
      };
    };
    let pages: readonly ResearchPage[] = row.research;
    if (row.state === 'research') {
      try {
        pages = await Promise.all(TOPICS[topic].pages.map((url) => (deps.research ?? fetchResearchPage)(url)));
      } catch (error) {
        return reject('rejected', [error instanceof ResearchRefusal ? error.code : 'research_failed']);
      }
      const frozen = await deps.withScope(deps.authority, async (scope) => {
        const tx = productionTransactionOf(scope);
        const current = await store.lock(tx, row.id);
        if (current.state !== 'research') return current;
        await store.research(tx, row.id, pages);
        return store.lock(tx, row.id);
      });
      if (frozen.kind !== 'entered')
        return { outcome: 'scope_refused', requestBound: REQUEST_BOUND_PER_TOPIC, runId: row.id };
      pages = frozen.value.research;
    }
    let claimPackage: ClaimPackage;

    if (row.state === 'writer' && row.claims !== null) claimPackage = row.claims;
    else {
      const claims = await deps.harness.proposeProduction(
        {
          run: run(row.claims_run_id, 'scroll-claims'),
          role: claimsRole(pages),
          context: {
            bundleRef: `scroll:${row.id}:research`,
            items: [
              { ref: `brief:${topic}`, kind: 'production_brief', text: TOPICS[topic].brief },
              ...pages.map((page) => ({
                ref: page.id,
                kind: 'public_research',
                text: JSON.stringify({ pageId: page.id, passages: page.passages }),
              })),
            ],
          },
          limits: { allowRepair: true },
        },
        signal,
      );
      receipts.push(receipt('claims', claims));
      if (claims.kind !== 'proposed')
        return reject(claims.kind === 'unknown' ? 'unknown' : 'rejected', [claims.kind], row.claims_run_id);
      const accepted = await deps.withScope(deps.authority, async (scope) => {
        const tx = productionTransactionOf(scope);
        const current = await store.lock(tx, row.id);
        if (current.state !== 'claims') return false;
        if (
          (await deps.harness.closeProductionRun(scope, { runId: row.claims_run_id, state: 'completed' })) !== 'closed'
        )
          return false;
        await store.claims(tx, row.id, claims.output, receipt('claims', claims));
        return true;
      });
      if (accepted.kind !== 'entered' || !accepted.value)
        return { outcome: 'scope_refused', requestBound: REQUEST_BOUND_PER_TOPIC, runId: row.id };
      claimPackage = claims.output;
      receipts.length = 0;
    }
    // Validation identity is fixed before dispatch. Final provenance substitutes the actual writer
    // attempt identity; publication data/claims are otherwise identical and all checks run again.
    const provenance = generatedProvenance({
      topic,
      revision: row.target_revision,
      runId: row.writer_run_id,
      attemptIds: [row.writer_run_id],
      model: deps.model,
      claims: claimPackage,
      pages,
    });
    const writer = await deps.harness.proposeProduction(
      {
        run: run(row.writer_run_id, 'scroll-writer'),
        role: writerRole(provenance, topic !== 'greenhouse'),
        context: {
          bundleRef: `scroll:${row.id}:claims`,
          items: [
            { ref: `brief:${topic}`, kind: 'production_brief', text: TOPICS[topic].brief },
            { ref: `claims:${row.id}`, kind: 'checked_claims', text: JSON.stringify(claimPackage) },
          ],
        },
        limits: { allowRepair: true },
      },
      signal,
    );
    receipts.push(receipt('writer', writer));
    if (writer.kind !== 'proposed')
      return reject(writer.kind === 'unknown' ? 'unknown' : 'rejected', [writer.kind], row.writer_run_id);
    const compiled = compileGeneratedDraft(
      writer.output,
      {
        ...provenance,
        production: {
          kind: 'model',
          runId: row.writer_run_id,
          attemptIds: [writer.attemptId],
          model: deps.model,
          promptVersion: SCROLL_PRODUCTION_VERSION,
        },
      },
      topic !== 'greenhouse',
    );
    if (compiled.kind === 'refused')
      return reject(
        'rejected',
        compiled.issues.map((issue) => issue.code),
        row.writer_run_id,
      );
    const applied = await deps.withScope(deps.authority, async (scope) => {
      const tx = productionTransactionOf(scope);
      const current = await store.lock(tx, row.id);
      if (current.state !== 'writer') return false;
      const stored = await inAdmissionTransaction(tx, async (admissionTx) => {
        const asset = await admission.lockAsset(admissionTx, TOPICS[topic].assetId);
        if (
          (asset.kind === 'absent' && row.target_revision !== 1) ||
          (asset.kind === 'present' &&
            (asset.assetKind !== 'scroll' || asset.status !== 'admitted' || asset.revision !== row.target_revision - 1))
        ) {
          await deps.harness.closeProductionRun(scope, { runId: row.writer_run_id, state: 'failed' });
          await store.finish(tx, row.id, 'rejected', [
            ...receipts,
            { role: 'checks', kind: 'rejected', code: 'asset_conflict' },
          ]);
          return false;
        }
        if (
          (await deps.harness.closeProductionRun(scope, { runId: row.writer_run_id, state: 'completed' })) !== 'closed'
        )
          return false;
        await admission.storeRevision(admissionTx, {
          assetId: TOPICS[topic].assetId,
          revision: row.target_revision,
          provenanceKind: 'generated',
          compiled,
          createsAsset: asset.kind === 'absent',
        });
        return true;
      });
      if (stored)
        await store.finish(
          tx,
          row.id,
          'published',
          receipts,
          { assetId: TOPICS[topic].assetId, revision: row.target_revision },
          writer.output,
        );
      return stored;
    });
    if (applied.kind !== 'entered')
      return { outcome: 'scope_refused', requestBound: REQUEST_BOUND_PER_TOPIC, runId: row.id };
    const final = await store.read(topic);
    return final === undefined
      ? { outcome: 'in_progress', requestBound: REQUEST_BOUND_PER_TOPIC, runId: row.id }
      : summary(final);
  };
}
