import type { Kysely } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { canonicalJson } from '../../../infrastructure/receipts/index.js';
import { productionTransactionOf } from '../../../infrastructure/postgres/index.js';
import {
  fetchResearchPage,
  ResearchRefusal,
  type ResearchPage,
} from '../../../infrastructure/research/public-pages.js';
import type {
  ProductionAttemptAccounting,
  ProductionAuthority,
  ProductionReasoningHarness,
  ProposeOutcome,
  WithProductionScope,
} from '../../../reasoning/public.js';
import { inAdmissionTransaction, makeAdmissionStore } from '../adapters/postgres-store.js';
import {
  type ClaimPackage,
  claimsRole,
  compileGeneratedDraft,
  generatedProvenance,
  writerRole,
  WRITER_PROMPT_VERSION,
} from './roles.js';
import { completeWriterPublication } from './publication-topic.js';
import { productionStore, type ProductionRow, type ProductionStage } from './store.js';
import {
  quoteCandidates,
  verifyHydratedClaims,
  QuoteCandidateRefusal,
  QUOTE_CANDIDATE_POLICY,
} from './quote-candidates.js';
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
function accountingReceipt(base: RoleReceipt, attempts: readonly ProductionAttemptAccounting[]): RoleReceipt {
  const input = attempts.map((a) => a.usage.inputTokens);
  const output = attempts.map((a) => a.usage.outputTokens);
  return {
    ...base,
    attempts,
    inputTokens: input.every((n) => n !== null) ? input.reduce<number>((sum, n) => sum + (n ?? 0), 0) : undefined,
    outputTokens: output.every((n) => n !== null) ? output.reduce<number>((sum, n) => sum + (n ?? 0), 0) : undefined,
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
    const { created } = reserved.value;
    let { row } = reserved.value;
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
    const replayCurrent = async (): Promise<ProduceScrollResult> => {
      const current = await deps.withScope(deps.authority, (scope) =>
        store.lock(productionTransactionOf(scope), row.id),
      );
      return current.kind === 'entered'
        ? summary(current.value)
        : { outcome: 'scope_refused', requestBound: REQUEST_BOUND_PER_TOPIC, runId: row.id };
    };
    const reject = async (
      expectedStage: ProductionStage,
      state: 'rejected' | 'unknown',
      codes: readonly string[],
      runId?: string,
    ): Promise<ProduceScrollResult> => {
      const closed = await deps.withScope(deps.authority, async (scope) => {
        const tx = productionTransactionOf(scope);
        const current = await store.lock(tx, row.id);
        // A delayed delivery owns only the stage it executed. Never close a run or reject a job
        // that another delivery has already advanced, including while its writer is in flight.
        if (current.state !== expectedStage) return summary(current);
        if (runId !== undefined && receipts[0] !== undefined) {
          const accounting = await deps.harness.readProductionRunAccounting(scope, runId);
          if (accounting.kind === 'accounted') receipts[0] = accountingReceipt(receipts[0], accounting.attempts);
        }
        if (runId !== undefined && state !== 'unknown')
          await deps.harness.closeProductionRun(scope, { runId, state: 'failed' });
        await store.finish(tx, row.id, expectedStage, state, [
          ...receipts,
          ...codes.slice(0, 32).map((code) => ({ role: 'checks' as const, kind: state, code })),
        ]);
        return { ...summary(await store.lock(tx, row.id)), codes };
      });
      return closed.kind === 'entered'
        ? closed.value
        : { outcome: 'scope_refused', requestBound: REQUEST_BOUND_PER_TOPIC, runId: row.id };
    };
    let pages: readonly ResearchPage[] = row.research;
    if (row.state === 'research') {
      try {
        pages = await Promise.all(TOPICS[topic].pages.map((url) => (deps.research ?? fetchResearchPage)(url)));
      } catch (error) {
        return reject('research', 'rejected', [error instanceof ResearchRefusal ? error.code : 'research_failed']);
      }
      const frozen = await deps.withScope(deps.authority, async (scope) => {
        const tx = productionTransactionOf(scope);
        const current = await store.lock(tx, row.id);
        if (current.state !== 'research') return { row: current, advanced: true };
        await store.research(tx, row.id, pages);
        return { row: await store.lock(tx, row.id), advanced: false };
      });
      if (frozen.kind !== 'entered')
        return { outcome: 'scope_refused', requestBound: REQUEST_BOUND_PER_TOPIC, runId: row.id };
      if (frozen.value.advanced) return summary(frozen.value.row);
      row = frozen.value.row;
      pages = row.research;
    }
    // Rebuild and verify even on a resumed writer stage before using stored hydrated claims.
    // A corrupt/insufficient source pool must never reach provider admission.
    let candidates: ReturnType<typeof quoteCandidates>;
    try {
      candidates = quoteCandidates(pages);
      if (row.state === 'writer' && row.claims !== null) verifyHydratedClaims(pages, candidates, row.claims);
    } catch (error) {
      if (row.state !== 'claims' && row.state !== 'writer') return summary(row);
      return reject(row.state, 'rejected', [
        error instanceof QuoteCandidateRefusal || error instanceof ResearchRefusal ? error.code : 'candidate_failed',
      ]);
    }
    let claimPackage: ClaimPackage;

    if (row.state === 'writer' && row.claims !== null) claimPackage = row.claims;
    else {
      if (row.state !== 'claims') return summary(row);
      const claims = await deps.harness.proposeProduction(
        {
          run: run(row.claims_run_id, 'scroll-claims'),
          role: claimsRole(pages),
          context: {
            bundleRef: `scroll:${row.id}:research`,
            items: [
              { ref: `brief:${topic}`, kind: 'production_brief', text: TOPICS[topic].brief },
              {
                ref: `quote-candidates:${row.id}`,
                kind: 'public_research_candidates',
                text: canonicalJson({
                  policyVersion: QUOTE_CANDIDATE_POLICY,
                  candidates: candidates.map(({ id, pageId, passageId, start, end, text }) => ({
                    id,
                    pageId,
                    passageId,
                    start,
                    end,
                    text,
                  })),
                }),
              },
            ],
          },
          limits: { allowRepair: true },
        },
        signal,
      );
      receipts.push(receipt('claims', claims));
      if (claims.kind === 'refused' && claims.reason === 'run_closed') return replayCurrent();
      if (claims.kind !== 'proposed')
        return reject('claims', claims.kind === 'unknown' ? 'unknown' : 'rejected', [claims.kind], row.claims_run_id);
      const accepted = await deps.withScope(deps.authority, async (scope) => {
        const tx = productionTransactionOf(scope);
        const current = await store.lock(tx, row.id);
        if (current.state !== 'claims') return { row: current, accepted: false };
        const accounting = await deps.harness.readProductionRunAccounting(scope, row.claims_run_id);
        if (accounting.kind !== 'accounted') return { row: current, accepted: false };
        if (
          (await deps.harness.closeProductionRun(scope, { runId: row.claims_run_id, state: 'completed' })) !== 'closed'
        )
          return { row: current, accepted: false };
        await store.claims(
          tx,
          row.id,
          claims.output,
          accountingReceipt(receipt('claims', claims), accounting.attempts),
        );
        return { row: await store.lock(tx, row.id), accepted: true };
      });
      if (accepted.kind !== 'entered')
        return { outcome: 'scope_refused', requestBound: REQUEST_BOUND_PER_TOPIC, runId: row.id };
      if (!accepted.value.accepted) return summary(accepted.value.row);
      row = accepted.value.row;
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
            { ref: `claims:${row.id}`, kind: 'checked_claims', text: canonicalJson(claimPackage) },
          ],
        },
        limits: { allowRepair: true },
      },
      signal,
    );
    receipts.push(receipt('writer', writer));
    if (writer.kind === 'refused' && writer.reason === 'run_closed') return replayCurrent();
    if (writer.kind !== 'proposed')
      return reject('writer', writer.kind === 'unknown' ? 'unknown' : 'rejected', [writer.kind], row.writer_run_id);
    const writerAccounting = await deps.withScope(deps.authority, (scope) =>
      deps.harness.readProductionRunAccounting(scope, row.writer_run_id),
    );
    if (writerAccounting.kind !== 'entered' || writerAccounting.value.kind !== 'accounted')
      return reject('writer', 'rejected', ['accounting_unavailable'], row.writer_run_id);
    const writerAttempts = writerAccounting.value.attempts;
    receipts[0] = accountingReceipt(receipt('writer', writer), writerAttempts);
    const paidAttemptIds = writerAttempts
      .filter((attempt) => !['reserved', 'not_sent'].includes(attempt.state))
      .map((attempt) => attempt.attemptId);
    if (paidAttemptIds.length < 1 || paidAttemptIds.length > 2)
      return reject('writer', 'rejected', ['attempt_bound_exceeded'], row.writer_run_id);
    const compiled = compileGeneratedDraft(
      writer.output,
      {
        ...provenance,
        production: {
          kind: 'model',
          runId: row.writer_run_id,
          attemptIds: paidAttemptIds,
          model: deps.model,
          promptVersion: WRITER_PROMPT_VERSION,
        },
      },
      topic !== 'greenhouse',
    );
    if (compiled.kind === 'refused')
      return reject(
        'writer',
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
          await store.finish(tx, row.id, 'writer', 'rejected', [
            ...receipts,
            { role: 'checks', kind: 'rejected', code: 'asset_conflict' },
          ]);
          return false;
        }
        return completeWriterPublication(scope, deps.harness, row.id, row.writer_run_id, async () => {
          await admission.storeRevision(admissionTx, {
            assetId: TOPICS[topic].assetId,
            revision: row.target_revision,
            provenanceKind: 'generated',
            compiled,
            createsAsset: asset.kind === 'absent',
          });
          await store.finish(
            tx,
            row.id,
            'writer',
            'published',
            receipts,
            { assetId: TOPICS[topic].assetId, revision: row.target_revision },
            writer.output,
          );
        });
      });
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
