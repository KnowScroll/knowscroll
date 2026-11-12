import { evaluateCanary, runsPending, type Evaluation, type OperatorReads } from '../../domain/canary/evaluate.js';
import { personaPlan, readShareFor, watchShareFor, type PersonaId } from '../../domain/canary/personas.js';
import { runPersonaJourney } from './journeys.js';
import { CanaryAborted, CanaryApiError, type CanaryApi, type CanaryOptions, type CanaryPorts } from './ports.js';
import { ReaderSession } from './session.js';

/** How long deleting one canary account may take before the run reports it unfinished. */
const DELETION_WAIT_MS = 180_000;
/** After an abort the operator is waiting: deletion is asked for at once and waited on for this long. */
const ABORTED_DELETION_WAIT_MS = 60_000;
const RUN_POLL_MS = 10_000;
const DELETION_POLL_MS = 2_000;

/** Why a run was told to stop. */
export type AbortReason = 'sigint' | 'sigterm' | 'sighup' | 'timeout';
const ABORT_REASONS: readonly string[] = ['sigint', 'sigterm', 'sighup', 'timeout'];

/** The run could not start or finish its set-up, for a reason the operator can act on. Carries a code only. */
export class CanaryRunFailed extends Error {
  override readonly name = 'CanaryRunFailed';
  constructor(
    readonly code: 'mint_refused' | 'sign_in_failed',
    /** Accounts that were made but could not be signed in, so could not be deleted through their own session. */
    readonly orphaned: number,
    /** The refusal the mint gave, as its own stable code. */
    readonly reason?: string,
  ) {
    super(code);
  }
}

interface ReportBase {
  readonly durationSeconds: number;
  readonly cleanup: { readonly kept: boolean; readonly requested: number; readonly completed: number };
  /** Reading waits are always real time: the server bounds every claim by the time since activation. */
  readonly pacing: 'wall_clock';
}

/** A finished run, judged; or one that was told to stop, which is not judged (it saw too little) but is cleaned up. */
export type CanaryReport =
  | (ReportBase & { readonly kind: 'completed'; readonly evaluation: Evaluation })
  | (ReportBase & { readonly kind: 'aborted'; readonly reason: AbortReason });

interface Entry {
  readonly persona: PersonaId;
  readonly api: CanaryApi;
  readonly session: ReaderSession;
}

async function readOperator(ports: CanaryPorts, universeIds: readonly string[]): Promise<OperatorReads | undefined> {
  try {
    return await ports.reads.read(universeIds);
  } catch {
    return undefined;
  }
}

/** Reads the operator views until no Planner or Cartographer run is on its way, or the bound passes, or the run is stopped. */
async function readWhenSettled(
  ports: CanaryPorts,
  universeIds: readonly string[],
  waitMs: number,
  signal: AbortSignal | undefined,
): Promise<OperatorReads | undefined> {
  const deadline = ports.pacer.nowMs() + waitMs;
  let reads = await readOperator(ports, universeIds);
  while (reads !== undefined && runsPending(reads) && ports.pacer.nowMs() < deadline && signal?.aborted !== true) {
    await ports.pacer.sleep(RUN_POLL_MS, signal);
    reads = await readOperator(ports, universeIds);
  }
  return reads;
}

/**
 * Deletes one canary account through the real account flow and waits, within `waitMs`, for its receipt to say
 * `completed` (asking once more when it says `needs_retry`). Never throws for a refusal: it answers whether it finished.
 */
export async function deleteThroughAccountFlow(ports: CanaryPorts, api: CanaryApi, waitMs: number): Promise<boolean> {
  const receiptId = ports.newId();
  const deadline = ports.pacer.nowMs() + waitMs;
  try {
    await api.deleteAccount(receiptId);
    let retried = false;
    for (;;) {
      const state = await api.deletionState(receiptId);
      if (state === 'completed') return true;
      if (state === 'needs_retry' && !retried) {
        retried = true;
        await api.retryDeletion(receiptId);
      }
      if (ports.pacer.nowMs() >= deadline) return false;
      await ports.pacer.sleep(DELETION_POLL_MS);
    }
  } catch (error) {
    if (error instanceof CanaryApiError) return false;
    throw error;
  }
}

async function deleteAccounts(ports: CanaryPorts, entries: readonly Entry[], waitMs: number): Promise<number> {
  const finished = await Promise.all(entries.map(({ api }) => deleteThroughAccountFlow(ports, api, waitMs)));
  return finished.filter(Boolean).length;
}

function abortReasonOf(signal: AbortSignal): AbortReason {
  const reason: unknown = signal.reason;
  return typeof reason === 'string' && ABORT_REASONS.includes(reason) ? (reason as AbortReason) : 'sigterm';
}

/**
 * Runs the canary: mints a disposable account for each persona with `issueOperatorSignIn`, signs each in through
 * the real HTTP route, drives the public API as that persona, waits (bounded) for readings to be projected and for
 * the places and Planner runs they entitle, reads back through the public routes and the read-only operator views,
 * judges the invariants, and deletes the accounts through the real deletion flow unless `keep` is set.
 *
 * It touches only the accounts it made, which it knows by their own sessions. Minting writes accounts and audit rows;
 * everything after goes through the public routes, so what it causes (evidence, Planner and Cartographer model calls
 * within the world's caps) is what a reader causes. It never fakes time: reading is paced on the wall clock because
 * the server bounds claimed intervals by the time since activation (`elapsedCapMs`), so `speed` changes the reader,
 * not the waiting.
 *
 * Abort: when `signal` is aborted (a signal, or the overall time) the journeys end at their next step, nothing more
 * is waited for or judged, and the accounts are deleted with a bounded wait. Failure: a refusal to mint or sign in
 * stops the run with a code, after the accounts already made are deleted. An unexpected error also deletes them,
 * then is thrown. A refusal inside a journey is recorded as a stable code and judged by the evaluator.
 */
export async function runCanary(
  ports: CanaryPorts,
  options: CanaryOptions,
  signal?: AbortSignal,
): Promise<CanaryReport> {
  const startedAt = ports.pacer.nowMs();
  const waitMs = options.waitSeconds * 1000;
  const entries: Entry[] = [];
  let orphaned = 0;
  let cleaned = false;
  const aborted = () => signal?.aborted === true;
  try {
    for (const persona of options.personas) {
      if (aborted()) break;
      const minted = await ports.accounts.mint(options.addressFor(persona));
      if (minted.kind === 'refused') throw new CanaryRunFailed('mint_refused', orphaned, minted.reason);
      let api: CanaryApi;
      try {
        api = await ports.accounts.signIn(minted.link);
      } catch {
        orphaned += 1;
        throw new CanaryRunFailed('sign_in_failed', orphaned);
      }
      const plan = personaPlan(persona, { manyReads: options.manyReads });
      const shares = {
        read: readShareFor(plan.readShare, options.speed),
        watch: watchShareFor(plan.readShare, options.speed),
      };
      entries.push({
        persona,
        api,
        session: new ReaderSession(persona, api, ports.reads, ports.pacer, ports.newId, shares, signal),
      });
    }

    await Promise.all(
      entries.map(async ({ persona, session }) => {
        try {
          await runPersonaJourney(session, personaPlan(persona, { manyReads: options.manyReads }), {
            waitMs,
            pacer: ports.pacer,
          });
        } catch (error) {
          if (!(error instanceof CanaryAborted)) session.noteUnexpected();
        }
      }),
    );

    if (signal !== undefined && aborted()) {
      const completed = options.keep ? 0 : await deleteAccounts(ports, entries, ABORTED_DELETION_WAIT_MS);
      cleaned = true;
      return {
        kind: 'aborted',
        reason: abortReasonOf(signal),
        durationSeconds: Math.round((ports.pacer.nowMs() - startedAt) / 1000),
        cleanup: { kept: options.keep, requested: options.keep ? 0 : entries.length, completed },
        pacing: 'wall_clock',
      };
    }

    const reads = await readWhenSettled(
      ports,
      entries.map((entry) => entry.api.account.universeId),
      waitMs,
      signal,
    );
    const personas = entries.map((entry) => entry.session.snapshot());
    const stopped = aborted();
    const deleted = options.keep
      ? 0
      : await deleteAccounts(ports, entries, stopped ? ABORTED_DELETION_WAIT_MS : DELETION_WAIT_MS);
    cleaned = true;
    const cleanup = { kept: options.keep, requested: options.keep ? 0 : entries.length, completed: deleted };
    const durationSeconds = Math.round((ports.pacer.nowMs() - startedAt) / 1000);
    if (signal !== undefined && stopped)
      return { kind: 'aborted', reason: abortReasonOf(signal), durationSeconds, cleanup, pacing: 'wall_clock' };
    return {
      kind: 'completed',
      evaluation: evaluateCanary({ personas, reads, cleanup }, { strict: options.strict }),
      durationSeconds,
      cleanup,
      pacing: 'wall_clock',
    };
  } catch (error) {
    // A failed set-up or an unexpected error: the accounts already made are still deleted.
    if (!options.keep && !cleaned) await deleteAccounts(ports, entries, ABORTED_DELETION_WAIT_MS).catch(() => 0);
    if (error instanceof CanaryRunFailed) throw new CanaryRunFailed(error.code, orphaned, error.reason);
    throw error;
  }
}
