import { releaseClaim, summaryOf, type AttemptSummary } from './attempt-steps.js';
import type { ReelAttemptRecord, ReelPorts } from './ports.js';

/**
 * Cutroom answers a request in the same transaction that stores it. A request that left more than
 * this long ago and still has no run was never received and never will be.
 */
const QUIET_PERIOD_MS = 120_000;

export interface WriteOffCommand {
  readonly attemptId: string;
  readonly reason: string;
  /** Also give the pool claim back, because Cutroom provably never received the request. */
  readonly releaseClaim: boolean;
}

export type WriteOffResult =
  | {
      readonly kind: 'refused';
      readonly code:
        'no_such_attempt' | 'not_unknown' | 'run_exists' | 'engine_unreachable' | 'not_quiet_yet' | 'pool_unavailable';
    }
  | { readonly kind: 'written_off'; readonly attempt: AttemptSummary };

/** Releasing needs proof: Cutroom answers, has no run for the request, and the POST is long over. */
async function neverReceived(p: ReelPorts, attempt: ReelAttemptRecord): Promise<WriteOffResult | undefined> {
  const found = await p.engine.lookup(attempt.requestId);
  if (found.kind === 'found') return { kind: 'refused', code: 'run_exists' };
  if (found.kind === 'unreachable' || !(await p.engine.ready())) return { kind: 'refused', code: 'engine_unreachable' };
  const sent = attempt.dispatchedAt?.getTime() ?? 0;
  return p.now().getTime() - sent < QUIET_PERIOD_MS ? { kind: 'refused', code: 'not_quiet_yet' } : undefined;
}

/**
 * Records that an uncertain attempt will not be pursued, with the operator's reason. By default the
 * pool claim stays open and its whole ceiling stays counted: a write-off does not prove that
 * Cutroom did nothing, and nothing is ever resent. With `releaseClaim` the claim goes back too, but
 * only when Cutroom answers, has no run for the request and the POST left at least two minutes ago.
 * Only an attempt that is `unknown` (or `dispatched`, which means the same) can be written off.
 */
export function makeWriteOff(p: ReelPorts) {
  return async (command: WriteOffCommand): Promise<WriteOffResult> => {
    const attempt = await p.ledger.readAttempt(command.attemptId);
    if (attempt === undefined) return { kind: 'refused', code: 'no_such_attempt' };
    if (attempt.state !== 'unknown' && attempt.state !== 'dispatched') return { kind: 'refused', code: 'not_unknown' };
    if (command.releaseClaim) {
      const proof = await neverReceived(p, attempt);
      if (proof !== undefined) return proof;
    }
    const unknown =
      attempt.state === 'dispatched'
        ? await p.ledger.advance(attempt.id, { kind: 'unknown', code: 'written_off_while_dispatched' })
        : attempt;
    const done = unknown && (await p.ledger.advance(attempt.id, { kind: 'written_off', reason: command.reason }));
    if (!done) return { kind: 'refused', code: 'not_unknown' };
    if (!command.releaseClaim) return { kind: 'written_off', attempt: summaryOf(done) };
    const released = await releaseClaim(p, done);
    return released === undefined
      ? { kind: 'refused', code: 'pool_unavailable' }
      : { kind: 'written_off', attempt: summaryOf(released) };
  };
}
