import { summaryOf, type AttemptSummary } from './attempt-steps.js';
import type { ReelPorts } from './ports.js';

export type WriteOffResult =
  | { readonly kind: 'refused'; readonly code: 'no_such_attempt' | 'not_unknown' }
  | { readonly kind: 'written_off'; readonly attempt: AttemptSummary };

/**
 * Records that an uncertain attempt will not be pursued. It does not prove that Cutroom did
 * nothing: the pool claim stays open and its whole ceiling stays counted, and nothing is ever
 * resent. Only an attempt that is `unknown` (or `dispatched`, which means the same) can be written
 * off, and the reason is kept with it.
 */
export function makeWriteOff(p: Pick<ReelPorts, 'ledger'>) {
  return async (command: { readonly attemptId: string; readonly reason: string }): Promise<WriteOffResult> => {
    const attempt = await p.ledger.readAttempt(command.attemptId);
    if (attempt === undefined) return { kind: 'refused', code: 'no_such_attempt' };
    if (attempt.state !== 'unknown' && attempt.state !== 'dispatched') return { kind: 'refused', code: 'not_unknown' };
    const unknown =
      attempt.state === 'dispatched'
        ? await p.ledger.advance(attempt.id, { kind: 'unknown', code: 'written_off_while_dispatched' })
        : attempt;
    const done = unknown && (await p.ledger.advance(attempt.id, { kind: 'written_off', reason: command.reason }));
    return done ? { kind: 'written_off', attempt: summaryOf(done) } : { kind: 'refused', code: 'not_unknown' };
  };
}
