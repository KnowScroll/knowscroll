import type { LogEvent } from '../../infrastructure/observability/index.js';
import type {
  AttemptLedger,
  RejectedAnswerReader,
  RejectedAnswerRecord,
  RejectedAnswerSummary,
  UnknownAttempt,
  WriteOffResult,
} from './ports.js';

/** Longest write-off reason kept on the attempt. */
export const MAX_WRITE_OFF_REASON_CHARS = 500;

/**
 * An admitted run nobody has touched for this long, with no live attempt, is closed by the sweep.
 * It is far beyond a claim (19 minutes) and its retries, so a run that still has work to do is
 * never taken from its owner.
 */
export const IDLE_RUN_CLOSES_AFTER_SECONDS = 6 * 60 * 60;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// `cli:<name>`, as the API operator's audit rows record who ran a command.
const sourcePattern = /^cli:[a-z_][a-z0-9_.-]{0,31}$/;
// Printable text only (letters, marks, numbers, punctuation, symbols, spaces).
const printable = /^[\p{L}\p{M}\p{N}\p{P}\p{S} ]+$/u;

export type WriteOffRequestResult = WriteOffResult | { readonly kind: 'invalid_request'; readonly problem: string };

/**
 * Operator actions on the attempt ledger (blueprint §15 reconciliation). MiniMax offers no request
 * lookup, so an `unknown` attempt stays unknown until an operator writes it off. A write-off
 * records unresolved liability with its reason; it never resends, never proves that remote work
 * stopped, never frees the reservation charged to the budget, and never authorises a late answer.
 */
export function makeReasoningOperator(ports: {
  readonly ledger: AttemptLedger;
  readonly rejectedAnswers: RejectedAnswerReader;
  readonly logEvent: LogEvent;
}) {
  return {
    /**
     * `unknown → written_off` for one attempt. Inputs: the attempt ID (UUID), a printable reason
     * (1–500 characters; stored on the attempt, never logged) and who runs the command (`cli:<name>`,
     * stored on the attempt). Output: `written_off`,
     * `not_unknown` (with the current state: nothing changed), `missing`, or `invalid_request`.
     * Authority: operator shell only (the CLI runs with the world's database credential). Side
     * effects: the attempt row, its usage receipt state and one `reasoning.attempt_written_off`
     * diagnostic. Safe to repeat: a second write-off answers `not_unknown`.
     */
    async writeOff(attemptId: string, reason: string, source: string): Promise<WriteOffRequestResult> {
      const trimmed = reason.trim();
      if (!uuidPattern.test(attemptId)) return { kind: 'invalid_request', problem: 'attempt_not_a_uuid' };
      if (!sourcePattern.test(source)) return { kind: 'invalid_request', problem: 'source_not_a_cli_name' };
      if (trimmed.length === 0 || trimmed.length > MAX_WRITE_OFF_REASON_CHARS || !printable.test(trimmed))
        return { kind: 'invalid_request', problem: 'reason_not_printable_or_out_of_range' };
      const result = await ports.ledger.writeOff(attemptId, trimmed, source);
      ports.logEvent('reasoning.attempt_written_off', {
        attemptId,
        outcome: result.kind,
        ...(result.kind === 'not_unknown' ? { reasonCode: result.state } : {}),
      });
      return result;
    },
    /** Attempts awaiting reconciliation or write-off (IDs, provider, model, role, code, time). */
    listUnknown(limit: number): Promise<readonly UnknownAttempt[]> {
      return ports.ledger.listUnknown(Math.min(Math.max(1, Math.trunc(limit)), 500));
    },
    /**
     * Moves attempts left `dispatched` for longer than `olderThanSeconds` to `unknown` (crash
     * recovery; the scheduled sweep calls this). Returns how many moved. Never resends; a late
     * answer still reconciles the attempt. Safe to repeat.
     */
    async sweepStaleDispatched(olderThanSeconds: number): Promise<number> {
      let total = 0;
      for (
        let batch = await ports.ledger.sweepStaleDispatched(olderThanSeconds, 200);
        batch > 0;
        batch = await ports.ledger.sweepStaleDispatched(olderThanSeconds, 200)
      )
        total += batch;
      if (total > 0) ports.logEvent('reasoning.dispatched_swept', { count: total });
      return total;
    },
    /**
     * Closes personal runs left `admitted` and idle for `olderThanSeconds` (see
     * `AttemptLedger.closeIdleRuns`; the scheduled sweep calls this). Returns how many closed. Never
     * touches an attempt, so no answer, charge or liability changes. Safe to repeat.
     */
    async closeIdleRuns(olderThanSeconds: number): Promise<number> {
      const close = ports.ledger.closeIdleRuns;
      if (close === undefined) return 0;
      let total = 0;
      for (let batch = await close(olderThanSeconds, 200); batch > 0; batch = await close(olderThanSeconds, 200))
        total += batch;
      if (total > 0) ports.logEvent('reasoning.idle_runs_closed', { count: total });
      return total;
    },
    /** Refused answers of nonpersonal production attempts, newest first, without their text. */
    listRejectedAnswers(limit: number): Promise<readonly RejectedAnswerSummary[]> {
      return ports.rejectedAnswers.list(limit);
    },
    /** One refused answer with its text and the validator's findings, or `invalid_request` / `missing`. */
    async showRejectedAnswer(
      attemptId: string,
    ): Promise<
      | { readonly kind: 'found'; readonly record: RejectedAnswerRecord }
      | { readonly kind: 'missing' }
      | { readonly kind: 'invalid_request'; readonly problem: string }
    > {
      if (!uuidPattern.test(attemptId)) return { kind: 'invalid_request', problem: 'attempt_not_a_uuid' };
      const record = await ports.rejectedAnswers.read(attemptId);
      return record === undefined ? { kind: 'missing' } : { kind: 'found', record };
    },
    /** Deletes expired protected request bytes now (the harness also does this periodically). */
    async purgeExpired(): Promise<number> {
      let total = 0;
      for (
        let batch = await ports.ledger.purgeExpiredRequests(500);
        batch > 0;
        batch = await ports.ledger.purgeExpiredRequests(500)
      )
        total += batch;
      if (total > 0) ports.logEvent('reasoning.requests_purged', { count: total });
      return total;
    },
  };
}

export type ReasoningOperator = ReturnType<typeof makeReasoningOperator>;
