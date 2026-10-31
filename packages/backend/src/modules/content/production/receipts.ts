import type { ProductionAttemptAccounting, ProposeOutcome } from '../../../reasoning/public.js';
import type { RoleReceipt } from './types.js';

/** The receipt of a writer outcome: what happened, never the text. */
export function writerReceipt(result: ProposeOutcome<unknown>): RoleReceipt {
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
export function withAccounting(base: RoleReceipt, attempts: readonly ProductionAttemptAccounting[]): RoleReceipt {
  const input = attempts.map((attempt) => attempt.usage.inputTokens);
  const output = attempts.map((attempt) => attempt.usage.outputTokens);
  const total = (counts: readonly (number | null)[]) =>
    counts.every((count) => count !== null) ? counts.reduce<number>((sum, count) => sum + (count ?? 0), 0) : undefined;
  return { ...base, attempts, inputTokens: total(input), outputTokens: total(output) };
}
