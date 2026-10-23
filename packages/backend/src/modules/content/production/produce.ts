import type { Kysely } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
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
import { EvidenceRefusal, evidencePassages, evidenceText, type EvidencePassage } from './evidence.js';
import { completeWriterPublication } from './publication-topic.js';
import { productionStore, type ProductionRow, type ProductionStage } from './store.js';
import type { ProduceScrollResult, RoleReceipt } from './types.js';
import { REQUEST_BOUND_PER_TOPIC, SCROLL_PRODUCTION_VERSION, TOPICS, type ScrollTopic } from './topics.js';
import {
  compileGeneratedScroll,
  generatedProvenance,
  writerFormatOf,
  writerRole,
  WRITER_PROMPT_VERSION,
} from './writer.js';

export interface ProduceScrollDependencies {
  readonly db: Kysely<Database>;
  readonly authority: ProductionAuthority;
  readonly withScope: WithProductionScope;
  readonly harness: ProductionReasoningHarness;
  readonly model: string;
  readonly research?: (url: string) => Promise<ResearchPage>;
}

const TERMINAL_STATES: readonly ProductionRow['state'][] = ['published', 'rejected', 'unknown'];

function writerReceipt(result: ProposeOutcome<unknown>): RoleReceipt {
  return {
    role: 'writer',
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

/** The receipt with every paid attempt's identity and usage; totals are known only when every attempt reported. */
function withAccounting(base: RoleReceipt, attempts: readonly ProductionAttemptAccounting[]): RoleReceipt {
  const input = attempts.map((attempt) => attempt.usage.inputTokens);
  const output = attempts.map((attempt) => attempt.usage.outputTokens);
  const total = (counts: readonly (number | null)[]) =>
    counts.every((count) => count !== null) ? counts.reduce<number>((sum, count) => sum + (count ?? 0), 0) : undefined;
  return { ...base, attempts, inputTokens: total(input), outputTokens: total(output) };
}

function summary(row: ProductionRow): ProduceScrollResult {
  return {
    outcome: TERMINAL_STATES.includes(row.state) ? (row.state as 'published' | 'rejected' | 'unknown') : 'in_progress',
    requestBound: REQUEST_BOUND_PER_TOPIC,
    runId: row.id,
    ...(row.asset_id === null ? {} : { assetId: row.asset_id, revision: row.asset_revision ?? undefined }),
    attempts: row.outcomes,
  };
}

/**
 * Produce one versioned, nonpersonal Scroll: reserve a unique topic/version once, freeze public
 * research, ask the writer once (and repair once), and atomically close and apply the publication
 * under the production root. No network or model wait holds a transaction. A repeated command
 * reports the prior terminal outcome; `resume` continues the same frozen job and harness ledger
 * after a crash. Unknown attempts halt: they are never resent. Scope revocation prevents applying
 * even a valid answer.
 */
export function makeProduceScroll(deps: ProduceScrollDependencies) {
  const store = productionStore(deps.db);
  const admission = makeAdmissionStore(deps.db);
  const scopeRefused = (runId?: string): ProduceScrollResult => ({
    outcome: 'scope_refused',
    requestBound: REQUEST_BOUND_PER_TOPIC,
    ...(runId === undefined ? {} : { runId }),
  });

  /** The job as it stands now, for a delivery that finds its stage already advanced. */
  async function replayCurrent(row: ProductionRow): Promise<ProduceScrollResult> {
    const current = await deps.withScope(deps.authority, (scope) => store.lock(productionTransactionOf(scope), row.id));
    return current.kind === 'entered' ? summary(current.value) : scopeRefused(row.id);
  }

  /**
   * Ends the job in a terminal state. A delivery owns only the stage it executed: if another
   * delivery already advanced the job, this reports the job as it is instead of rejecting it.
   */
  async function end(
    row: ProductionRow,
    expectedStage: ProductionStage,
    state: 'rejected' | 'unknown',
    codes: readonly string[],
    receipts: readonly RoleReceipt[],
    writerRunId?: string,
  ): Promise<ProduceScrollResult> {
    const closed = await deps.withScope(deps.authority, async (scope) => {
      const tx = productionTransactionOf(scope);
      const current = await store.lock(tx, row.id);
      if (current.state !== expectedStage) return summary(current);
      const recorded = [...receipts];
      if (writerRunId !== undefined && recorded[0] !== undefined) {
        const accounting = await deps.harness.readProductionRunAccounting(scope, writerRunId);
        if (accounting.kind === 'accounted') recorded[0] = withAccounting(recorded[0], accounting.attempts);
      }
      if (writerRunId !== undefined && state !== 'unknown')
        await deps.harness.closeProductionRun(scope, { runId: writerRunId, state: 'failed' });
      await store.finish(tx, row.id, expectedStage, state, [
        ...recorded,
        ...codes.slice(0, 32).map((code) => ({ role: 'checks' as const, kind: state, code })),
      ]);
      return { ...summary(await store.lock(tx, row.id)), codes };
    });
    return closed.kind === 'entered' ? closed.value : scopeRefused(row.id);
  }

  /** Fetches the topic's public pages (no lock held) and freezes them on the job. */
  async function freezeResearch(
    topic: ScrollTopic,
    row: ProductionRow,
  ): Promise<{ readonly pages: readonly ResearchPage[]; readonly row: ProductionRow } | ProduceScrollResult> {
    let pages: readonly ResearchPage[];
    try {
      pages = await Promise.all(TOPICS[topic].pages.map((url) => (deps.research ?? fetchResearchPage)(url)));
    } catch (error) {
      return end(row, 'research', 'rejected', [error instanceof ResearchRefusal ? error.code : 'research_failed'], []);
    }
    const frozen = await deps.withScope(deps.authority, async (scope) => {
      const tx = productionTransactionOf(scope);
      const current = await store.lock(tx, row.id);
      if (current.state !== 'research') return { row: current, advanced: true };
      await store.research(tx, row.id, pages);
      return { row: await store.lock(tx, row.id), advanced: false };
    });
    if (frozen.kind !== 'entered') return scopeRefused(row.id);
    return frozen.value.advanced
      ? summary(frozen.value.row)
      : { pages: frozen.value.row.research, row: frozen.value.row };
  }

  /** Closes the writer run and stores the revision, its provenance and the topic projection in one transaction. */
  async function publish(
    topic: ScrollTopic,
    row: ProductionRow,
    receipts: readonly RoleReceipt[],
    authored: unknown,
    compiled: Extract<ReturnType<typeof compileGeneratedScroll>, { kind: 'compiled' }>,
  ): Promise<ProduceScrollResult> {
    const applied = await deps.withScope(deps.authority, async (scope) => {
      const tx = productionTransactionOf(scope);
      const current = await store.lock(tx, row.id);
      if (current.state !== 'writer') return false;
      return inAdmissionTransaction(tx, async (admissionTx) => {
        const asset = await admission.lockAsset(admissionTx, TOPICS[topic].assetId);
        const revisionConflict =
          (asset.kind === 'absent' && row.target_revision !== 1) ||
          (asset.kind === 'present' &&
            (asset.assetKind !== 'scroll' ||
              asset.status !== 'admitted' ||
              asset.revision !== row.target_revision - 1));
        if (revisionConflict) {
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
            { authored, claims: compiled.provenance['claims'] },
          );
        });
      });
    });
    if (applied.kind !== 'entered') return scopeRefused(row.id);
    const final = await store.read(topic);
    return final === undefined
      ? { outcome: 'in_progress', requestBound: REQUEST_BOUND_PER_TOPIC, runId: row.id }
      : summary(final);
  }

  /** The writer stage: ask once (the harness allows one repair), then compile with the real attempt identities and publish. */
  async function writeAndPublish(
    topic: ScrollTopic,
    row: ProductionRow,
    pages: readonly ResearchPage[],
    signal: AbortSignal,
  ): Promise<ProduceScrollResult> {
    let passages: readonly EvidencePassage[];
    try {
      passages = evidencePassages(pages);
    } catch (error) {
      return end(row, 'writer', 'rejected', [error instanceof EvidenceRefusal ? error.code : 'evidence_failed'], []);
    }
    const format = writerFormatOf(TOPICS[topic]);
    // The validation identity is fixed before dispatch; the final provenance substitutes the actual attempts.
    const provenance = generatedProvenance({
      topic,
      revision: row.target_revision,
      runId: row.writer_run_id,
      attemptIds: [row.writer_run_id],
      model: deps.model,
      passages,
      pages,
    });
    const writer = await deps.harness.proposeProduction(
      {
        run: {
          id: row.writer_run_id,
          authority: deps.authority,
          ownerModule: 'content',
          purpose: 'scroll-writer',
          policyVersion: SCROLL_PRODUCTION_VERSION,
        },
        role: writerRole({ provenance, passages, format }),
        context: {
          bundleRef: `scroll:${row.id}:research`,
          items: [
            { ref: `brief:${topic}`, kind: 'production_brief', text: TOPICS[topic].brief },
            { ref: `evidence:${row.id}`, kind: 'public_research_passages', text: evidenceText(passages) },
          ],
        },
        limits: { allowRepair: true },
      },
      signal,
    );
    if (writer.kind === 'refused' && writer.reason === 'run_closed') return replayCurrent(row);
    const receipt = writerReceipt(writer);
    if (writer.kind !== 'proposed')
      return end(
        row,
        'writer',
        writer.kind === 'unknown' ? 'unknown' : 'rejected',
        [writer.kind],
        [receipt],
        row.writer_run_id,
      );

    const accounting = await deps.withScope(deps.authority, (scope) =>
      deps.harness.readProductionRunAccounting(scope, row.writer_run_id),
    );
    if (accounting.kind !== 'entered' || accounting.value.kind !== 'accounted')
      return end(row, 'writer', 'rejected', ['accounting_unavailable'], [receipt], row.writer_run_id);
    const attempts = accounting.value.attempts;
    const paidAttemptIds = attempts
      .filter((attempt) => !['reserved', 'not_sent'].includes(attempt.state))
      .map((attempt) => attempt.attemptId);
    if (paidAttemptIds.length < 1 || paidAttemptIds.length > 2)
      return end(row, 'writer', 'rejected', ['attempt_bound_exceeded'], [receipt], row.writer_run_id);
    const recorded = [withAccounting(receipt, attempts)];

    const compiled = compileGeneratedScroll(
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
      passages,
      format,
    );
    if (compiled.kind === 'refused')
      return end(
        row,
        'writer',
        'rejected',
        compiled.issues.map((issue) => issue.code),
        recorded,
        row.writer_run_id,
      );
    return publish(topic, row, recorded, writer.output, compiled);
  }

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
    if (reserved.kind !== 'entered') return scopeRefused();
    const { created } = reserved.value;
    let { row } = reserved.value;
    if (!created && (!resume || TERMINAL_STATES.includes(row.state))) return summary(row);
    if (row.scope_generation !== deps.authority.generation) return scopeRefused(row.id);

    let pages: readonly ResearchPage[] = row.research;
    if (row.state === 'research') {
      const frozen = await freezeResearch(topic, row);
      if ('outcome' in frozen) return frozen;
      ({ row, pages } = frozen);
    }
    if (row.state !== 'writer') return summary(row);
    return writeAndPublish(topic, row, pages, signal);
  };
}
