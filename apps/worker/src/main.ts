/** The projection worker. One loop, in a fixed order each turn: heartbeat, projection, answer
 * pass, inquiry pass, abandoned-work sweeps, supply pass, correction refresh, 300 ms pause.
 * Invariants: the heartbeat query sits outside every try, so a database error there ends the
 * process (owner decision); a failed duty logs its error code and the loop carries on; bad env
 * values are clamped silently here, unlike the other entrypoints which exit 1. */
import { setTimeout } from 'node:timers/promises';
import { pool } from '@knowscroll/db';
import { recordWorkerHeartbeat } from '@knowscroll/db/projection/heartbeat';
import { settleAbandonedAnswers } from '@knowscroll/db/reasoning/answers';
import { settleInquiries } from '@knowscroll/db/reasoning/inquiry-execution';
import { runCorrectionRefreshPass } from '@knowscroll/db/semantic/correction-refresh';
import { projectOne } from './project.ts';
import { runAnswerPass } from './reasoning/answer-worker.ts';
import {
  executeInquiryClaim,
  runInquiryPass,
} from './reasoning/inquiry-worker.ts';
import { createReadinessGate } from './reasoning/readiness-gate.ts';
import {
  answerTransportsFromEnvironment,
  inquiryTransportsFromEnvironment,
  scrollTransportsFromEnvironment,
} from './reasoning/transport-selection.ts';
import { logError, logLine } from './runtime/log.ts';
import { lenientIntSetting } from './runtime/settings.ts';
import { onStopSignal } from './runtime/stop-signal.ts';
import { runSupplyPass } from './scrolls/supply-worker.ts';

let running = true;
onStopSignal(() => {
  running = false;
});
const workerId = `local-${process.pid}`;
// Answers and background inquiries run only when this process was configured with a
// transport for them (ADR-0033 §2, ADR-0038 §2).
const answerTransports = answerTransportsFromEnvironment(process.env);
const inquiryTransports = inquiryTransportsFromEnvironment(
  process.env,
  answerTransports,
);
// Shared supply requests are written only when this process has a Scroll-writing transport (ADR-0046 §3).
const scrollTransports = scrollTransportsFromEnvironment(
  process.env,
  answerTransports,
);
// Leases on admitted attempts; bounded by admission's own 1..60,000 ms limit.
const leaseMs = (name: string) =>
  lenientIntSetting(name, 60_000, 1_000, 60_000);
const answerLeaseMs = leaseMs('KS_ANSWER_LEASE_MS');
const inquiryLeaseMs = leaseMs('KS_INQUIRY_LEASE_MS');
// Provider readiness (quota) at most every 30 s while work waits; a refusal backs off 60 s. One gate
// per transport instance, so a MiniMax client shared by both paths is asked once per window.
const gates = new Map<object, ReturnType<typeof createReadinessGate>>();
const gatesFor = (transports: Record<string, object | undefined> | null) =>
  transports
    ? Object.fromEntries(
        Object.entries(transports).map(([k, t]) => {
          if (!gates.has(t!))
            gates.set(
              t!,
              createReadinessGate(
                t as Parameters<typeof createReadinessGate>[0],
              ),
            );
          return [k, gates.get(t!)!];
        }),
      )
    : {};
const readiness = gatesFor(answerTransports);
const inquiryReadiness = gatesFor(inquiryTransports);
// Readers behind a source correction are caught up on an interval (at least 1 s), a bounded batch
// (1..100) at a time. Deterministic database work only; no model is called (ADR-0040).
const correctionRefreshMs = lenientIntSetting(
  'KS_CORRECTION_REFRESH_INTERVAL_MS',
  60_000,
  1_000,
);
const correctionRefreshBatch = Math.min(
  100,
  Math.max(
    1,
    Math.trunc(Number(process.env.KS_CORRECTION_REFRESH_BATCH ?? 8) || 8),
  ),
);
// ADR-0046 §3: supply requests are written on an interval (at least 1 s). A request the readiness
// gate held back (the quota preflight) is tried again after a minute, never at once.
const scrollSupplyMs = lenientIntSetting(
  'KS_SCROLL_SUPPLY_INTERVAL_MS',
  5_000,
  1_000,
);
let lastSweep = 0,
  lastCorrectionRefresh = 0,
  refreshDeferred: string[] = [],
  nextScrollSupply = 0;
const stop = new AbortController();
onStopSignal(() => stop.abort());
logLine({
  service: 'worker',
  workerId,
  kind: 'deterministic-projection',
  answers: answerTransports ? Object.keys(answerTransports) : [],
  inquiries: inquiryTransports ? Object.keys(inquiryTransports) : [],
  scrolls: scrollTransports ? Object.keys(scrollTransports) : [],
});
// A background inquiry the answer route's shared scheduler admits is run by the inquiry path (ADR-0038 §4).
const inquiries = inquiryTransports
  ? {
      transports: inquiryTransports,
      readiness: inquiryReadiness,
      execute: executeInquiryClaim,
    }
  : undefined;

/** Deliberately outside any try: one transient database error here ends the process. */
async function heartbeat(): Promise<void> {
  await recordWorkerHeartbeat(pool, workerId);
}

async function projectionTick(): Promise<void> {
  try {
    const result = await projectOne();
    if (result) logLine(result);
  } catch {
    logError({ error: 'projection_failed' });
  }
}

// Logs below carry ids and outcome kinds only, never a question, a claim, a reply or a key.
async function answerPass(): Promise<void> {
  if (!answerTransports) return;
  try {
    const pass = await runAnswerPass({
      pool,
      owner: workerId,
      leaseMs: answerLeaseMs,
      transports: answerTransports,
      readiness,
      signal: stop.signal,
      inquiries,
    });
    if (pass.kind === 'done')
      logLine({
        answer: pass.askId,
        invocation: pass.invocation,
        outcome: pass.outcome.kind,
        status:
          'status' in pass.outcome ? pass.outcome.status : pass.outcome.reason,
      });
    if (pass.kind === 'other_family')
      logLine({ inquiryJob: pass.jobId, via: 'answer_scheduler' });
  } catch {
    logError({ error: 'answer_pass_failed' });
  }
}

async function inquiryPass(): Promise<void> {
  if (!inquiryTransports) return;
  try {
    const pass = await runInquiryPass({
      pool,
      owner: workerId,
      leaseMs: inquiryLeaseMs,
      transports: inquiryTransports,
      readiness: inquiryReadiness,
      signal: stop.signal,
      answers: answerTransports
        ? { transports: answerTransports, readiness }
        : undefined,
    });
    if (pass.opened.opened || pass.opened.nothing_to_ask)
      logLine({
        inquiriesOpened: pass.opened.opened,
        nothingToAsk: pass.opened.nothing_to_ask,
      });
    if (pass.kind === 'done')
      logLine({
        inquiry: pass.inquiryId,
        invocation: pass.invocation,
        outcome: pass.outcome.kind,
        status:
          'status' in pass.outcome
            ? pass.outcome.status
            : 'ordinal' in pass.outcome
              ? `step_${pass.outcome.ordinal}_queued`
              : pass.outcome.reason,
      });
    if (pass.kind === 'answer' && pass.pass.kind === 'done')
      logLine({
        answer: pass.pass.askId,
        invocation: pass.pass.invocation,
        outcome: pass.pass.outcome.kind,
        via: 'inquiry_scheduler',
      });
  } catch {
    logError({ error: 'inquiry_pass_failed' });
  }
}

/** Work whose worker died is closed once its lease expires, at most every 5 s (ADR-0038 §6). */
async function abandonedWorkSweeps(): Promise<void> {
  if (
    (answerTransports || inquiryTransports) &&
    Date.now() - lastSweep >= 5_000
  ) {
    lastSweep = Date.now();
    if (answerTransports) {
      try {
        const settled = await settleAbandonedAnswers(pool, {
          owner: workerId,
        });
        if (settled) logLine({ answersSettled: settled });
      } catch {
        logError({ error: 'answer_sweep_failed' });
      }
    }
    if (inquiryTransports) {
      try {
        const settled = await settleInquiries(pool, { owner: workerId });
        if (settled) logLine({ inquiriesSettled: settled });
      } catch {
        logError({ error: 'inquiry_sweep_failed' });
      }
    }
  }
}

async function supplyPass(): Promise<void> {
  if (scrollTransports && Date.now() >= nextScrollSupply) {
    try {
      const pass = await runSupplyPass({
        pool,
        transports: scrollTransports,
        signal: stop.signal,
      });
      nextScrollSupply =
        Date.now() +
        (pass.kind === 'done' && pass.status === 'open'
          ? 60_000
          : scrollSupplyMs);
      if (pass.kind === 'done')
        logLine({
          supplyRequest: pass.requestId,
          status: pass.status,
          reasons: pass.reasons,
        });
    } catch {
      logError({ error: 'scroll_supply_failed' });
      nextScrollSupply = Date.now() + scrollSupplyMs;
    }
  }
}

async function correctionRefresh(): Promise<void> {
  if (Date.now() - lastCorrectionRefresh >= correctionRefreshMs) {
    lastCorrectionRefresh = Date.now();
    try {
      const pass = await runCorrectionRefreshPass(pool, {
        limit: correctionRefreshBatch,
        deferred: refreshDeferred,
      });
      refreshDeferred = pass.failed.map((f) => f.universeId);
      if (pass.refreshed.length || pass.failed.length)
        logLine({
          correctionRefresh: pass.refreshed,
          placeChanges: pass.placeChanges,
          failed: pass.failed,
        });
    } catch {
      logError({ error: 'correction_refresh_failed' });
    }
  }
}

try {
  while (running) {
    await heartbeat();
    await projectionTick();
    await answerPass();
    await inquiryPass();
    await abandonedWorkSweeps();
    await supplyPass();
    await correctionRefresh();
    await setTimeout(300);
  }
} finally {
  await pool.end();
}
