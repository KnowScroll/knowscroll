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
  ProductionScopeTx,
  WithProductionScope,
} from '../../../reasoning/public.js';
import { inAdmissionTransaction, makeAdmissionStore } from '../adapters/postgres-store.js';
import type { CompileOutcome } from '../application/ports.js';
import { completeWriterPublication } from './publication-topic.js';
import { withAccounting } from './receipts.js';
import { subjectOf, type ProductionKey, type ProductionSubject } from './subject.js';
import { productionStore, type ProductionRow, type ProductionStage } from './store.js';
import type { ClosingRun, ProduceScrollResult, RoleReceipt } from './types.js';
import { HELD_FOR_REVIEW_CODE, isHeldForReview } from './review-hold.js';
import { planRefusalOf, requestBoundOf } from './topics.js';
import { makeWriterStage } from './writer-stage.js';

export interface ProduceScrollDependencies {
  readonly db: Kysely<Database>;
  readonly authority: ProductionAuthority;
  readonly withScope: WithProductionScope;
  readonly harness: ProductionReasoningHarness;
  readonly model: string;
  readonly research?: (url: string) => Promise<ResearchPage>;
}

const TERMINAL_STATES: readonly ProductionRow['state'][] = ['published', 'rejected', 'unknown'];

/**
 * Research failures that say nothing about the recipe: the network, a slow or erroring host. They leave
 * the job at its research stage to be tried again; every other refusal is a verdict on the sources.
 */
const TRANSIENT_RESEARCH_REFUSALS: ReadonlySet<string> = new Set([
  'dns_timeout',
  'request_timeout',
  'network_failed',
  'http_refused',
]);

function summary(row: ProductionRow): ProduceScrollResult {
  return {
    take: row.take,
    outcome: TERMINAL_STATES.includes(row.state) ? (row.state as 'published' | 'rejected' | 'unknown') : 'in_progress',
    requestBound: requestBoundOf(row.topic),
    runId: row.id,
    ...(row.asset_id === null ? {} : { assetId: row.asset_id, revision: row.asset_revision ?? undefined }),
    attempts: row.outcomes,
  };
}

/**
 * Produce one versioned, nonpersonal Scroll: reserve one job per topic, version and take, freeze
 * public research, ask the writer once (and repair once), and atomically close and apply the
 * publication under the production root. No network or model wait holds a transaction. A repeated
 * command reports the prior terminal outcome; `resume` continues the same frozen job and harness
 * ledger after a crash. A rejected job is final for its take, but take 2 (then 3) may start once
 * every earlier take was rejected: a new business run with its own writer run, so nothing is
 * resent, and never after an unknown attempt or a published job, except that a v2 library recipe's
 * later take may follow a take whose Scroll was released (regeneration, D-197). Unknown attempts halt:
 * they are never resent. Scope revocation prevents applying even a valid answer. For a v2 library
 * recipe the writer's answer is checked before it is stored (D-198), and so is the answer to a person's
 * question, which is refused when it cannot be checked (D-250).
 */
export function makeProduceScroll(deps: ProduceScrollDependencies) {
  const store = productionStore(deps.db);
  const admission = makeAdmissionStore(deps.db);
  const scopeRefused = (key: string, runId?: string): ProduceScrollResult => ({
    outcome: 'scope_refused',
    requestBound: requestBoundOf(key),
    ...(runId === undefined ? {} : { runId }),
  });

  /** The job as it stands now, for a delivery that finds its stage already advanced. */
  async function replayCurrent(row: ProductionRow): Promise<ProduceScrollResult> {
    const current = await deps.withScope(deps.authority, (scope) => store.lock(productionTransactionOf(scope), row.id));
    return current.kind === 'entered' ? summary(current.value) : scopeRefused(row.topic, row.id);
  }

  /** Closes the reasoning runs a job used, in the transaction that ends it. */
  async function closeRuns(scope: ProductionScopeTx, runs: readonly ClosingRun[]): Promise<void> {
    for (const run of runs) await deps.harness.closeProductionRun(scope, run);
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
    alsoClose: readonly ClosingRun[] = [],
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
      // An attempt of unknown outcome keeps its run open, so nothing resends it.
      if (state !== 'unknown') {
        if (writerRunId !== undefined) await closeRuns(scope, [{ runId: writerRunId, state: 'failed' }]);
        await closeRuns(scope, alsoClose);
      }
      await store.finish(tx, row.id, expectedStage, state, [
        ...recorded,
        ...codes.slice(0, 32).map((code) => ({ role: 'checks' as const, kind: state, code })),
      ]);
      return { ...summary(await store.lock(tx, row.id)), codes };
    });
    return closed.kind === 'entered' ? closed.value : scopeRefused(row.topic, row.id);
  }

  /** Fetches the subject's public pages (no lock held) and freezes them on the job. */
  async function freezeResearch(
    subject: ProductionSubject,
    row: ProductionRow,
  ): Promise<{ readonly pages: readonly ResearchPage[]; readonly row: ProductionRow } | ProduceScrollResult> {
    let pages: readonly ResearchPage[];
    try {
      pages = await Promise.all(subject.pages.map((url) => (deps.research ?? fetchResearchPage)(url)));
    } catch (error) {
      const refusal = error instanceof ResearchRefusal ? error : undefined;
      // A take is spent only on a verdict about the sources or the answer, never on a blip.
      if (refusal === undefined || TRANSIENT_RESEARCH_REFUSALS.has(refusal.code)) {
        // Another delivery may have frozen the research and moved on while this one waited on the network.
        const current = await deps.withScope(deps.authority, (scope) =>
          store.lock(productionTransactionOf(scope), row.id),
        );
        if (current.kind !== 'entered') return scopeRefused(row.topic, row.id);
        if (current.value.state !== 'research') return summary(current.value);
        return {
          outcome: 'retry_later',
          requestBound: requestBoundOf(row.topic),
          runId: row.id,
          take: row.take,
          codes: [refusal?.code ?? 'research_failed'],
        };
      }
      return end(row, 'research', 'rejected', [refusal.code], []);
    }
    const frozen = await deps.withScope(deps.authority, async (scope) => {
      const tx = productionTransactionOf(scope);
      const current = await store.lock(tx, row.id);
      if (current.state !== 'research') return { row: current, advanced: true };
      await store.research(tx, row.id, pages);
      return { row: await store.lock(tx, row.id), advanced: false };
    });
    if (frozen.kind !== 'entered') return scopeRefused(row.topic, row.id);
    return frozen.value.advanced
      ? summary(frozen.value.row)
      : { pages: frozen.value.row.research, row: frozen.value.row };
  }

  /**
   * Stores the revision, its provenance and the topic projection, and closes the runs the job used, in one
   * transaction. `writerRunId` is the writer run whose answer is stored (the answer check's repair is a
   * run of its own, D-198); the job names it from here on.
   */
  async function publish(
    subject: ProductionSubject,
    row: ProductionRow,
    receipts: readonly RoleReceipt[],
    authored: unknown,
    compiled: Extract<CompileOutcome, { kind: 'compiled' }>,
    writerRunId: string,
    alsoClose: readonly ClosingRun[],
  ): Promise<ProduceScrollResult> {
    const applied = await deps.withScope(deps.authority, async (scope) => {
      const tx = productionTransactionOf(scope);
      const current = await store.lock(tx, row.id);
      if (current.state !== 'writer') return false;
      return inAdmissionTransaction(tx, async (admissionTx) => {
        const asset = await admission.lockAsset(admissionTx, subject.identity.assetId);
        const held = isHeldForReview(subject);
        const revisionConflict =
          (asset.kind === 'absent' && row.target_revision !== 1) ||
          (asset.kind === 'present' &&
            (asset.assetKind !== 'scroll' ||
              asset.status === 'withdrawn' ||
              (asset.status === 'held' && !held) ||
              asset.latestRevision !== row.target_revision - 1));
        if (revisionConflict) {
          await closeRuns(scope, [{ runId: writerRunId, state: 'failed' }, ...alsoClose]);
          await store.finish(tx, row.id, 'writer', 'rejected', [
            ...receipts,
            { role: 'checks', kind: 'rejected', code: 'asset_conflict' },
          ]);
          return false;
        }
        return completeWriterPublication(
          scope,
          deps.harness,
          row.id,
          writerRunId,
          subject.attribution,
          async () => {
            // The job names the repair's run only now that publication has completed.
            if (writerRunId !== current.writer_run_id) await store.useWriterRun(tx, row.id, writerRunId);
            await closeRuns(scope, alsoClose);
            await admission.storeRevision(admissionTx, {
              assetId: subject.identity.assetId,
              revision: row.target_revision,
              provenanceKind: 'generated',
              compiled,
              createsAsset: asset.kind === 'absent',
              ...(held ? { held } : {}),
            });
            await store.finish(
              tx,
              row.id,
              'writer',
              'published',
              held ? [...receipts, { role: 'checks', kind: 'published', code: HELD_FOR_REVIEW_CODE }] : receipts,
              { assetId: subject.identity.assetId, revision: row.target_revision },
              { authored, claims: compiled.provenance['claims'] },
            );
          },
          current.writer_run_id,
        );
      });
    });
    if (applied.kind !== 'entered') return scopeRefused(subject.key, row.id);
    const final = await store.read(subject.key);
    if (final === undefined)
      return { outcome: 'in_progress', requestBound: requestBoundOf(subject.key), runId: row.id };
    return applied.value && isHeldForReview(subject) ? { ...summary(final), held: true } : summary(final);
  }

  const writeAndPublish = makeWriterStage(deps, {
    replayCurrent,
    end: (row, state, codes, receipts, closing) => end(row, 'writer', state, codes, receipts, undefined, closing),
    publish,
  });

  /** Runs a subject's job from reserving its take to the end of the writer stage. */
  async function runJob(
    subject: ProductionSubject,
    key: ProductionKey,
    signal: AbortSignal,
    resume: boolean,
    take: number,
  ): Promise<ProduceScrollResult> {
    const reserved = await deps.withScope(deps.authority, (scope) =>
      store.create(productionTransactionOf(scope), key, subject.identity.assetId, deps.authority.generation, take),
    );
    if (reserved.kind !== 'entered') return scopeRefused(key);
    if (reserved.value.kind === 'take_refused')
      return { outcome: 'take_refused', requestBound: requestBoundOf(key), take };
    const { created } = reserved.value;
    let { row } = reserved.value;
    if (!created && (!resume || TERMINAL_STATES.includes(row.state))) return summary(row);
    if (row.scope_generation !== deps.authority.generation) return scopeRefused(key, row.id);

    let pages: readonly ResearchPage[] = row.research;
    if (row.state === 'research') {
      const frozen = await freezeResearch(subject, row);
      if ('outcome' in frozen) return frozen;
      ({ row, pages } = frozen);
    }
    if (row.state !== 'writer') return summary(row);
    return writeAndPublish(subject, row, pages, signal);
  }

  return async (
    key: ProductionKey,
    dryRun: boolean,
    signal: AbortSignal,
    resume = false,
    take = 1,
  ): Promise<ProduceScrollResult> => {
    if (dryRun) return { outcome: 'dry_run', requestBound: requestBoundOf(key) };
    const subject = await subjectOf(deps.db, key);
    if (subject === undefined) return { outcome: 'unknown_recipe', requestBound: requestBoundOf(key) };
    // A recipe the plan does not allow costs nothing: no job is reserved and no request is sent.
    const refusal = planRefusalOf(key);
    if (refusal !== undefined) return { outcome: 'plan_refused', requestBound: requestBoundOf(key), codes: [refusal] };
    // The bound of what an order answers is known only once the order is read (D-250).
    const result = await runJob(subject, key, signal, resume, take);
    return { ...result, requestBound: requestBoundOf(key, subject.mode) };
  };
}
