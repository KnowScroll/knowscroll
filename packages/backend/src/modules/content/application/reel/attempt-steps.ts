import { MAX_CHAIN_RUNS, type ChainRun, type RunStatusFacts } from '../../domain/reel/chain.js';
import type { PoolIdentity, ReelAttemptRecord, ReelOrderRecord, ReelPorts } from './ports.js';

/** What a command tells the operator about an attempt. Plain facts, no request bytes. */
export interface AttemptSummary {
  readonly attemptId: string;
  readonly take: number;
  readonly requestId: string;
  readonly state: ReelAttemptRecord['state'];
  readonly poolState: ReelAttemptRecord['poolState'];
  readonly ceilingCents: number;
  readonly runId: string | null;
}

export function summaryOf(attempt: ReelAttemptRecord): AttemptSummary {
  return {
    attemptId: attempt.id,
    take: attempt.take,
    requestId: attempt.requestId,
    state: attempt.state,
    poolState: attempt.poolState,
    ceilingCents: attempt.ceilingCents,
    runId: attempt.runId,
  };
}

/**
 * Whether an attempt still needs a person or a command: it has not been sent, may have been sent,
 * is running, is waiting to be settled, or holds a claim that has not been given back. A written-off
 * attempt is a decision already taken and counts as ended.
 */
export function isOpen(attempt: ReelAttemptRecord): boolean {
  switch (attempt.state) {
    case 'reserved':
    case 'dispatched':
    case 'unknown':
      return true;
    case 'succeeded':
    case 'reconciled':
      return attempt.finished === null || (attempt.paid && attempt.poolState !== 'settled');
    case 'not_sent':
    case 'failed':
      return attempt.poolState === 'claimed';
    case 'written_off':
      return false;
  }
}

export function poolIdentityOf(world: string, order: ReelOrderRecord, attempt: ReelAttemptRecord): PoolIdentity {
  return {
    requestId: attempt.requestId,
    scriptSha256: order.scriptSha256,
    take: attempt.take,
    requestSha256: attempt.requestSha256,
    world,
    ceilingCents: attempt.ceilingCents,
    approvalRef: order.approvalRef,
  };
}

/**
 * Looks up an attempt that may have been sent (`dispatched`, `unknown`) by its request id. A run
 * that exists settles the question; "absent" does not, because the request may still be on its way.
 * Nothing is ever sent again.
 */
export async function reconcileAttempt(
  p: Pick<ReelPorts, 'engine' | 'ledger'>,
  attempt: ReelAttemptRecord,
): Promise<
  { readonly kind: 'reconciled'; readonly attempt: ReelAttemptRecord } | { readonly kind: 'absent' | 'unreachable' }
> {
  const found = await p.engine.lookup(attempt.requestId);
  if (found.kind !== 'found') return { kind: found.kind };
  // A dispatch intent a crash left behind is first recorded as unknown, then reconciled.
  const unknown =
    attempt.state === 'dispatched'
      ? await p.ledger.advance(attempt.id, { kind: 'unknown', code: 'intent_without_answer' })
      : attempt;
  const reconciled = unknown && (await p.ledger.advance(attempt.id, { kind: 'reconciled', runId: found.status.runId }));
  return reconciled ? { kind: 'reconciled', attempt: reconciled } : { kind: 'unreachable' };
}

export type ChainRead =
  { readonly kind: 'chain'; readonly runs: readonly ChainRun[] } | { readonly kind: 'absent' | 'unreachable' };

/**
 * Reads every run of one request, original first: back from the run we know to the run it
 * continues, then forward along `resumedBy`. Finished runs bring their results. The loops are
 * bounded; a longer chain is reported as one and refused by `foldChain`.
 */
export async function readChain(p: Pick<ReelPorts, 'engine'>, knownRunId: string): Promise<ChainRead> {
  const bound = MAX_CHAIN_RUNS + 1;
  const order: string[] = [knownRunId];
  const statuses = new Map<string, RunStatusFacts>();
  async function load(runId: string): Promise<'ok' | 'absent' | 'unreachable'> {
    const found = await p.engine.status(runId);
    if (found.kind !== 'found') return found.kind;
    statuses.set(runId, found.status);
    return 'ok';
  }
  const first = await load(knownRunId);
  if (first !== 'ok') return { kind: first };
  for (let tip = statuses.get(knownRunId)!; tip.resumes !== undefined && order.length < bound;) {
    const loaded = await load(tip.resumes);
    if (loaded !== 'ok') return { kind: loaded };
    order.unshift(tip.resumes);
    tip = statuses.get(tip.resumes)!;
  }
  for (let tip = statuses.get(knownRunId)!; tip.resumedBy !== undefined && order.length < bound;) {
    const loaded = await load(tip.resumedBy);
    if (loaded !== 'ok') return { kind: loaded };
    order.push(tip.resumedBy);
    tip = statuses.get(tip.resumedBy)!;
  }
  const runs: ChainRun[] = [];
  for (const runId of order) {
    const status = statuses.get(runId)!;
    if (status.state === 'finished') {
      const answered = await p.engine.result(runId);
      if (answered.kind === 'unreachable') return { kind: 'unreachable' };
      runs.push({ status, result: answered.kind === 'finished' ? answered.result : undefined });
    } else runs.push({ status });
  }
  return { kind: 'chain', runs };
}

/**
 * Gives back the pool claim of an attempt that never left (`not_sent`, or refused outright by
 * Cutroom) and returns the attempt as recorded afterwards. `undefined` when the pool could not be
 * reached: the claim stays open and counted until a later command closes it.
 */
export async function releaseClaim(
  p: Pick<ReelPorts, 'pool' | 'ledger' | 'world'>,
  attempt: ReelAttemptRecord,
): Promise<ReelAttemptRecord | undefined> {
  if (attempt.poolState !== 'claimed') return attempt;
  try {
    await p.pool.release(attempt.requestId, p.world);
  } catch {
    return undefined;
  }
  return (await p.ledger.advance(attempt.id, { kind: 'released' })) ?? attempt;
}
