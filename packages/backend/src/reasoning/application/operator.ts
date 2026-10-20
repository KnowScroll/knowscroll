import type { LogEvent } from '../../infrastructure/observability/index.js';
import type { AttemptLedger, UnknownAttempt, WriteOffResult } from './ports.js';

/** Longest write-off reason kept on the attempt. */
export const MAX_WRITE_OFF_REASON_CHARS = 500;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Printable text only (letters, marks, numbers, punctuation, symbols, spaces).
const printable = /^[\p{L}\p{M}\p{N}\p{P}\p{S} ]+$/u;

export type WriteOffRequestResult = WriteOffResult | { readonly kind: 'invalid_request'; readonly problem: string };

/**
 * Operator actions on the attempt ledger (blueprint §15 reconciliation). MiniMax offers no request
 * lookup, so an `unknown` attempt stays unknown until an operator writes it off. A write-off
 * records unresolved liability with its reason; it never resends, never proves that remote work
 * stopped, never frees the reservation charged to the budget, and never authorises a late answer.
 */
export function makeReasoningOperator(ports: { readonly ledger: AttemptLedger; readonly logEvent: LogEvent }) {
  return {
    /**
     * `unknown → written_off` for one attempt. Inputs: the attempt ID (UUID) and a printable reason
     * (1–500 characters; stored on the attempt, never logged). Output: `written_off`,
     * `not_unknown` (with the current state: nothing changed), `missing`, or `invalid_request`.
     * Authority: operator shell only (the CLI runs with the world's database credential). Side
     * effects: the attempt row, its usage receipt state and one `reasoning.attempt_written_off`
     * diagnostic. Safe to repeat: a second write-off answers `not_unknown`.
     */
    async writeOff(attemptId: string, reason: string): Promise<WriteOffRequestResult> {
      const trimmed = reason.trim();
      if (!uuidPattern.test(attemptId)) return { kind: 'invalid_request', problem: 'attempt_not_a_uuid' };
      if (trimmed.length === 0 || trimmed.length > MAX_WRITE_OFF_REASON_CHARS || !printable.test(trimmed))
        return { kind: 'invalid_request', problem: 'reason_not_printable_or_out_of_range' };
      const result = await ports.ledger.writeOff(attemptId, trimmed);
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
    /** Deletes expired protected request bytes now (the harness also does this periodically). */
    async purgeExpired(): Promise<number> {
      let total = 0;
      for (let batch = await ports.ledger.purgeExpiredRequests(500); batch > 0; batch = await ports.ledger.purgeExpiredRequests(500))
        total += batch;
      if (total > 0) ports.logEvent('reasoning.requests_purged', { count: total });
      return total;
    },
  };
}

export type ReasoningOperator = ReturnType<typeof makeReasoningOperator>;
