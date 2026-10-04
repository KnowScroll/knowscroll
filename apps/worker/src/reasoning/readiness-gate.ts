/**
 * A transport's readiness (for MiniMax, a quota request that carries the key), asked at most once
 * per window and spent by each dispatch, so every request has its own preflight (ADR-0033 §2,
 * ADR-0042 §3).
 */
import type { AnswerTransport } from '../providers/transports.ts';

type Readiness = { ok: true } | { ok: false; reason: string };
/** Asks a transport's readiness; `spend()` records that a request was dispatched on the trust it gave. */
export type ReadinessGate = ((signal: AbortSignal) => Promise<Readiness>) & {
  spend(): void;
};

/**
 * Provider readiness (a quota request that carries the key) is asked at most once per window, not
 * on every loop: a success is trusted for `okMs` while work waits, a refusal backs off for `failMs`
 * (#132 review I2). A dispatch spends the trusted success, so every request, a continuation included,
 * has its own preflight (ADR-0033 §2, ADR-0042 §3).
 */
export function createReadinessGate(
  transport: AnswerTransport,
  options: { okMs?: number; failMs?: number; now?: () => number } = {},
): ReadinessGate {
  const okMs = options.okMs ?? 30_000,
    failMs = options.failMs ?? 60_000,
    now = options.now ?? Date.now;
  let until = 0,
    last: Readiness = { ok: true };
  const gate = async (signal: AbortSignal): Promise<Readiness> => {
    if (!transport.ready) return { ok: true };
    if (now() < until) return last;
    last = await transport.ready(signal);
    until = now() + (last.ok ? okMs : failMs);
    return last;
  };
  return Object.assign(gate, {
    spend() {
      if (last.ok) until = 0;
    },
  });
}
