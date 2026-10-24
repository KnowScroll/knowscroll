import { describeEnd, foldChain } from '../../domain/reel/chain.js';
import type { ReelUntil } from '../../domain/reel/script.js';
import { summaryOf, readChain, reconcileAttempt, releaseClaim, type AttemptSummary } from './attempt-steps.js';
import { lintReelScript } from './assess.js';
import { publishFinishedReel, type FinishedChain } from './publish-step.js';
import type { FinishedFacts, ReelAttemptRecord, ReelOrderRecord, ReelPorts } from './ports.js';

export interface FollowCommand {
  readonly scriptName: string;
  readonly until: ReelUntil;
}

export type FollowResult =
  | { readonly kind: 'refused'; readonly code: 'no_order' | 'no_attempt' }
  /** Nothing is running for this attempt. `note` says what the operator can do. */
  | { readonly kind: 'idle'; readonly attempt: AttemptSummary; readonly note: string }
  /** The request may have been sent; Cutroom has no run for it yet. Nothing is resent. */
  | { readonly kind: 'unknown'; readonly attempt: AttemptSummary }
  | {
      readonly kind: 'running';
      readonly attempt: AttemptSummary;
      readonly runIds: readonly string[];
      readonly progress: readonly string[];
    }
  /** Something outside our control is not ready. Run the command again; nothing was lost. */
  | { readonly kind: 'held'; readonly attempt: AttemptSummary; readonly code: string }
  | {
      readonly kind: 'finished';
      readonly attempt: AttemptSummary;
      readonly outcome: FinishedFacts['outcome'];
      readonly costCents: number;
      readonly overCeiling: boolean;
      /** Why Cutroom stopped, for the operator. */
      readonly detail: string | null;
      /** Only for a rehearsal: what the plan estimates the Reel will cost. */
      readonly estimateCents?: number;
      readonly published?: { readonly assetId: string; readonly created: boolean };
      /** A completed Reel that will never be published (its money is still spent). */
      readonly reelRefused?: string;
      readonly settled: boolean;
    };

type Settlement = { readonly kind: 'settled'; readonly attempt: ReelAttemptRecord } | { readonly kind: 'held' };

/** Settles the pool claim once, at the real cost, then records that it is closed. */
async function settleClaim(
  ports: ReelPorts,
  attempt: ReelAttemptRecord,
  facts: FinishedFacts,
  outcome: FinishedFacts['outcome'],
): Promise<Settlement> {
  if (attempt.poolState === 'settled') return { kind: 'settled', attempt };
  try {
    await ports.pool.settle({
      requestId: attempt.requestId,
      world: ports.world,
      outcome,
      spentCents: facts.costCents,
      finalRunId: facts.finalRunId,
    });
  } catch {
    return { kind: 'held' };
  }
  const settled = await ports.ledger.advance(attempt.id, { kind: 'settled' });
  return settled ? { kind: 'settled', attempt: settled } : { kind: 'held' };
}

function factsOf(report: FinishedChain): FinishedFacts {
  return {
    outcome: report.outcome,
    costCents: report.costCents,
    finalRunId: report.finalRunId,
    runIds: report.runIds,
    detail: describeEnd(report.tip),
    estimateCents: report.tip.estimateCents ?? null,
  };
}

interface Conclusion {
  readonly ports: ReelPorts;
  readonly order: ReelOrderRecord;
  readonly attempt: ReelAttemptRecord;
  readonly report: FinishedChain;
  readonly runs: Parameters<typeof publishFinishedReel>[1]['runs'];
  readonly linted: Parameters<typeof publishFinishedReel>[1]['linted'];
}

function finishedResult(
  conclusion: Conclusion,
  extra: Partial<Extract<FollowResult, { kind: 'finished' }>>,
): FollowResult {
  return {
    kind: 'finished',
    attempt: summaryOf(conclusion.attempt),
    outcome: conclusion.report.outcome,
    costCents: conclusion.report.costCents,
    overCeiling: conclusion.report.costCents > conclusion.attempt.ceilingCents,
    detail: describeEnd(conclusion.report.tip),
    settled: conclusion.attempt.poolState === 'settled',
    ...extra,
  };
}

/**
 * What follows a finished request. A rehearsal only reports. A paid request that did not complete
 * is settled at its real cost. A completed one is published first and settled only then: a Reel
 * that cannot be imported keeps its claim open at its whole ceiling (CF-62). A Reel that can never
 * be published is settled as completed, because the money is spent.
 */
async function conclude(conclusion: Conclusion): Promise<FollowResult> {
  const { ports, attempt, report } = conclusion;
  const facts = factsOf(report);
  if (!attempt.paid)
    return finishedResult(
      conclusion,
      report.tip.estimateCents === undefined ? {} : { estimateCents: report.tip.estimateCents },
    );
  if (attempt.poolState === 'settled')
    return finishedResult(
      conclusion,
      conclusion.order.assetId === null
        ? { reelRefused: 'not_published' }
        : { published: { assetId: conclusion.order.assetId, created: false } },
    );
  if (report.outcome !== 'completed' || report.tip.until !== 'video') {
    const settled = await settleClaim(ports, attempt, facts, report.outcome);
    return settled.kind === 'held'
      ? { kind: 'held', attempt: summaryOf(attempt), code: 'pool_unavailable' }
      : finishedResult({ ...conclusion, attempt: settled.attempt }, {});
  }
  const published = await publishFinishedReel(ports, {
    linted: conclusion.linted,
    origin: { kind: 'ordered', orderId: conclusion.order.id, take: attempt.take, ceilingCents: attempt.ceilingCents },
    requestId: attempt.requestId,
    runs: conclusion.runs,
    report,
  });
  if (published.kind === 'held') return { kind: 'held', attempt: summaryOf(attempt), code: published.code };
  const settled = await settleClaim(ports, attempt, facts, 'completed');
  if (settled.kind === 'held') return { kind: 'held', attempt: summaryOf(attempt), code: 'pool_unavailable' };
  const done = { ...conclusion, attempt: settled.attempt };
  return published.kind === 'published'
    ? finishedResult(done, { published: { assetId: published.assetId, created: published.created } })
    : finishedResult(done, { reelRefused: published.code });
}

/** Records how the request ended, once, and returns the attempt as stored. */
async function recordFinish(
  ports: ReelPorts,
  attempt: ReelAttemptRecord,
  report: FinishedChain,
): Promise<ReelAttemptRecord | undefined> {
  if (attempt.finished !== null) return attempt;
  return ports.ledger.advance(attempt.id, { kind: 'finished', facts: factsOf(report) });
}

async function followRemote(
  ports: ReelPorts,
  order: ReelOrderRecord,
  reached: ReelAttemptRecord,
): Promise<FollowResult> {
  const held = (code: string): FollowResult => ({ kind: 'held', attempt: summaryOf(reached), code });
  // The script the order was made from, not whatever ships now.
  const linted = lintReelScript(ports, order.scriptName, order.script);
  if (linted.kind === 'refused') return held(linted.code);
  const chain = await readChain(ports, reached.runId!);
  if (chain.kind !== 'chain') return held(chain.kind === 'absent' ? 'run_absent' : 'engine_unreachable');
  const report = foldChain(reached.requestId, chain.runs);
  if (report.kind === 'broken') return held(report.code);
  if (report.kind === 'running')
    return {
      kind: 'running',
      attempt: summaryOf(reached),
      runIds: report.runIds,
      progress: await ports.engine.progress(report.runIds.at(-1)!),
    };
  const attempt = await recordFinish(ports, reached, report);
  if (attempt === undefined) return held('attempt_conflict');
  return conclude({ ports, order, attempt, report, runs: chain.runs, linted: linted.linted });
}

/**
 * Observes the latest attempt of an order and moves it on: reconciles an uncertain one, reads
 * Cutroom's runs, records how the request ended, and, once it has, settles the pool claim and
 * publishes the Reel. Safe to repeat at any point; every step is recorded before the next.
 *
 * Authority: an operator in a dev or stage world. Side effects: ledger moves, at most one pool
 * settlement, one media install and one admission transaction. Cutroom is only read.
 */
export function makeFollowReel(ports: ReelPorts) {
  return async (command: FollowCommand): Promise<FollowResult> => {
    const order = await ports.ledger.latestOrderOf(command.scriptName, command.until);
    if (order === undefined) return { kind: 'refused', code: 'no_order' };
    const attempt = (await ports.ledger.attemptsOf(order.id)).at(-1);
    if (attempt === undefined) return { kind: 'refused', code: 'no_attempt' };
    switch (attempt.state) {
      case 'reserved':
        return { kind: 'idle', attempt: summaryOf(attempt), note: 'not sent yet: run `reel order` to continue it' };
      case 'not_sent':
      case 'failed': {
        const closed = (await releaseClaim(ports, attempt)) ?? attempt;
        return { kind: 'idle', attempt: summaryOf(closed), note: 'nothing is running for this attempt' };
      }
      case 'written_off':
        return { kind: 'idle', attempt: summaryOf(attempt), note: 'written off: its claim stays open and counted' };
      case 'dispatched':
      case 'unknown': {
        const looked = await reconcileAttempt(ports, attempt);
        if (looked.kind !== 'reconciled') return { kind: 'unknown', attempt: summaryOf(attempt) };
        return followRemote(ports, order, looked.attempt);
      }
      case 'succeeded':
      case 'reconciled':
        return followRemote(ports, order, attempt);
    }
  };
}
