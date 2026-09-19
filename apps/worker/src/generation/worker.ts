/** ADR-0023 section 6: the generation worker loop. Claims a job, authorizes exactly one POST,
 * records the outcome, follows events to a terminal run, fetches the result and settles, and
 * hands a completed video off to the (in this stage, unimplemented) import port. Holds no
 * provider credentials; talks to Cutroom only through the pinned, unwired HTTP client. Never
 * holds a database transaction across an HTTP call. */
import type pg from 'pg';
import {createCutroomHttpClient, prepareCutroomRequest, type CutroomRunRef} from '../cutroom/http-client.ts';
import {createUnimplementedImportPort, type ImportPort} from './import-port.ts';
import * as storage from './storage.ts';

export type GenerationWorkerOptions = {
  db: pg.Pool;
  owner: string;
  leaseMs?: number;
  pollMs?: number;
  maxFollowIterations?: number;
  maxLookupRetries?: number;
  importPort?: ImportPort;
  log?: (line: Record<string, unknown>) => void;
};

export type ProcessOutcome = {jobId: string; outcome: string; detail?: string};

type Resolved = Required<Pick<GenerationWorkerOptions, 'db' | 'owner' | 'leaseMs' | 'pollMs' | 'maxFollowIterations' | 'maxLookupRetries' | 'importPort'>> & {log: (line: Record<string, unknown>) => void};

function resolveOptions(options: GenerationWorkerOptions): Resolved {
  return {
    db: options.db,
    owner: options.owner,
    leaseMs: options.leaseMs ?? 30_000,
    pollMs: options.pollMs ?? 200,
    maxFollowIterations: options.maxFollowIterations ?? 300,
    maxLookupRetries: options.maxLookupRetries ?? 1,
    importPort: options.importPort ?? createUnimplementedImportPort(),
    log: options.log ?? ((line) => console.log(JSON.stringify(line))),
  };
}

async function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, {once: true});
  });
  return !signal?.aborted;
}

/** Recomputes the prepared request from the persisted bytes and refuses to return an object
 * usable for submission unless the recomputed identity and digest exactly match what dispatch
 * authorization returned from storage. A mismatch is a defect, never a new request. */
function reprepareOrThrow(dispatch: storage.DispatchGrant) {
  const reprepared = prepareCutroomRequest(JSON.parse(dispatch.body));
  if (reprepared.requestId !== dispatch.requestId || reprepared.bodySha256 !== dispatch.bodySha256) {
    throw new Error(`generation_worker_defect: re-prepared bytes do not match persisted identity/digest for attempt ${dispatch.attemptId}`);
  }
  return reprepared;
}

type Holder = {jobId: string; owner: string; leaseFence: string};

/** One dispatch attempt (first send or a bounded identical-bytes resend). Returns how the
 * outcome was recorded so the caller can decide what happens next. */
async function submitAndRecord(
  resolved: Resolved,
  holder: Holder,
  prepared: ReturnType<typeof prepareCutroomRequest>,
  client: ReturnType<typeof createCutroomHttpClient>,
  context: 'first' | 'resend',
): Promise<'accepted' | 'refused' | 'unknown'> {
  const result = await client.submit(prepared);
  if (result.kind === 'accepted') {
    await storage.recordAccepted(resolved.db, holder, {runId: result.value.runId, replayed: result.value.replayed});
    return 'accepted';
  }
  if (result.kind === 'refused') {
    await storage.recordRefused(resolved.db, holder, {
      reason: result.value.reason, detail: result.value.detail,
      httpStatus: result.value.reason === 'conflict' ? 409 : 422,
    });
    return 'refused';
  }
  // protocol_error / transport_error / remote_error: the contract's own uncertainty. Once the
  // attempt is dispatch_committed, the schema has no path back to prepared, so every other
  // outcome here is recorded as unknown and resolved later by lookup/resend, never assumed.
  resolved.log({service: 'generation-worker', event: 'submit_uncertain', jobId: holder.jobId, context, result});
  // Only the first submit transitions dispatch_committed -> unknown; a resend's uncertainty is
  // tracked by the caller's own bounded resend counter on an attempt that is already unknown.
  if (context === 'first') await storage.recordUnknown(resolved.db, holder, JSON.stringify(result));
  return 'unknown';
}

/** Resolves one 'unknown' attempt: first a lookup by the original request id (never a resend
 * trigger by itself), then — only on an observed 404, which the contract says is an observation
 * and never proof of non-delivery — a bounded loop of identical-bytes resends, each on a fresh
 * short backoff. A single call may walk all the way to the bound (parking the job) or stop the
 * moment either an accepted or refused outcome is observed. */
async function resolveUnknownAttempt(
  resolved: Resolved,
  holder: Holder,
  attempt: storage.AttemptSnapshot,
  client: ReturnType<typeof createCutroomHttpClient>,
  signal?: AbortSignal,
): Promise<'accepted' | 'refused' | 'still_unknown' | 'parked'> {
  const lookup = await client.lookup(attempt.requestId);
  if (lookup.kind === 'ok') {
    await storage.recordAccepted(resolved.db, holder, {runId: lookup.value.runId, replayed: null});
    return 'accepted';
  }
  if (lookup.kind !== 'not_found') {
    // Transport/protocol trouble reaching Cutroom at all: inconclusive, not a resend trigger.
    // The reservation stays held and a later claim cycle tries again.
    resolved.log({service: 'generation-worker', event: 'lookup_inconclusive', jobId: holder.jobId, lookup});
    return 'still_unknown';
  }
  // A 404 is an observation, never proof of non-delivery (ADR-0023). Because the contract
  // guarantees replay for the same requestId and JSON-equal body, resend the identical stored
  // bytes, bounded at 3, each attempt separated by a short backoff.
  for (;;) {
    const fresh = await storage.loadAttempt(resolved.db, holder.jobId);
    const resendCount = fresh?.resendCount ?? attempt.resendCount;
    if (resendCount >= storage.GENERATION_LIMITS.maxResendCount) {
      await storage.parkNeedsOperator(resolved.db, holder, 'exhausted 3 identical-bytes resends without resolution');
      return 'parked';
    }
    if (!await sleepUnlessAborted(Math.min(resolved.pollMs, 200), signal)) return 'still_unknown';
    // Record the resend attempt itself before sending: the attempt is still 'unknown' at this
    // point regardless of what this send goes on to observe, and a successful resend still counts
    // toward the bound (it is one of the at-most-3 extra sends, not a free pass).
    const resend = await storage.recordResend(resolved.db, holder);
    const prepared = reprepareOrThrow({
      attemptId: attempt.id, requestId: attempt.requestId, body: attempt.body,
      bodySha256: attempt.bodySha256, contractRevision: attempt.contractRevision,
      until: 'video', budgetCents: 0,
    } as storage.DispatchGrant);
    const outcome = await submitAndRecord(resolved, holder, prepared, client, 'resend');
    if (outcome === 'accepted') return 'accepted';
    if (outcome === 'refused') return 'refused';
    if (resend.resendCount >= storage.GENERATION_LIMITS.maxResendCount) {
      await storage.parkNeedsOperator(resolved.db, holder, 'exhausted 3 identical-bytes resends without resolution');
      return 'parked';
    }
  }
}

async function followToTerminal(
  resolved: Resolved,
  holder: Holder,
  ref: CutroomRunRef,
  client: ReturnType<typeof createCutroomHttpClient>,
  signal: AbortSignal | undefined,
  cancelRequested: () => Promise<boolean>,
): Promise<'finished' | 'aborted'> {
  let cancelSent = false;
  for (let iteration = 0; iteration < resolved.maxFollowIterations; iteration += 1) {
    if (signal?.aborted) return 'aborted';
    if (!cancelSent && await cancelRequested()) {
      await client.cancel(ref); // Idempotent per ADR-0023/ops evidence; safe to call once we learn of a request.
      cancelSent = true;
    }
    const attempt = await storage.loadAttempt(resolved.db, holder.jobId);
    if (!attempt) throw new Error('generation_worker_defect: attempt vanished while following');
    const page = await client.events(ref, attempt.nextSince);
    if (page.kind !== 'ok') {
      resolved.log({service: 'generation-worker', event: 'events_page_error', jobId: holder.jobId, page});
      if (!await sleepUnlessAborted(resolved.pollMs, signal)) return 'aborted';
      continue;
    }
    const {stored, nextSince} = await storage.appendEvents(resolved.db, holder, {
      events: page.value.events.map((event) => ({seq: event.seq, event})),
      nextSince: page.value.nextSince,
    });
    resolved.log({service: 'generation-worker', event: 'events_page', jobId: holder.jobId, stored, nextSince});
    if (page.value.events.some((event) => event.type === 'run.finished')) return 'finished';
    if (!await sleepUnlessAborted(resolved.pollMs, signal)) return 'aborted';
  }
  return 'aborted';
}

async function fetchResultAndRecord(resolved: Resolved, holder: Holder, ref: CutroomRunRef, client: ReturnType<typeof createCutroomHttpClient>): Promise<{jobStatus: string; enginePath: string | null}> {
  let resultValue: Awaited<ReturnType<typeof client.result>> | null = null;
  for (let attempt = 0; attempt <= resolved.maxLookupRetries; attempt += 1) {
    const outcome = await client.result(ref);
    if (outcome.kind === 'ok') { resultValue = outcome; break; }
    if (outcome.kind === 'pending') { await sleepUnlessAborted(resolved.pollMs); continue; }
    throw new Error(`generation_worker_defect: result fetch failed after run.finished: ${JSON.stringify(outcome)}`);
  }
  if (!resultValue || resultValue.kind !== 'ok') throw new Error('generation_worker_defect: result never resolved after run.finished');
  const value = resultValue.value;
  const {jobStatus} = await storage.recordResult(resolved.db, holder, {status: value.status, costCents: value.costCents, body: value});

  const record = await client.record(ref);
  if (record.kind === 'ok') await storage.recordRecordSummary(resolved.db, holder, record.value);
  else resolved.log({service: 'generation-worker', event: 'record_unavailable', jobId: holder.jobId, record});

  await storage.settle(resolved.db, holder);
  const enginePath = value.status === 'completed' && value.until === 'video' ? value.video.path : null;
  return {jobStatus, enginePath};
}

/** Processes exactly one claimed job through as much of its lifecycle as this stage owns.
 * Never sends more than one first-submit POST and never resends after a refusal. */
export async function processClaimedJob(options: GenerationWorkerOptions, claim: storage.ClaimedGenerationJob, signal?: AbortSignal): Promise<ProcessOutcome> {
  const resolved = resolveOptions(options);
  const holder: Holder = {jobId: claim.jobId, owner: resolved.owner, leaseFence: claim.fence};
  const engine = await storage.engineOrigin(resolved.db, claim.engineId);
  if (!engine) throw new Error('generation_worker_defect: claimed job names an unknown engine');
  const client = createCutroomHttpClient({origin: engine.origin});

  let attempt = await storage.loadAttempt(resolved.db, claim.jobId);
  if (!attempt) throw new Error('generation_worker_defect: claimed job has no attempt row');

  if (attempt.state === 'prepared') {
    const cancelled = claim.cancelRequestedAt !== null;
    const overdue = claim.deadlineAt.getTime() <= Date.now();
    if (cancelled || overdue) {
      await storage.closeNotSent(resolved.db, holder, cancelled ? 'cancelled' : 'deadline');
      return {jobId: claim.jobId, outcome: cancelled ? 'cancelled_before_dispatch' : 'deadline_before_dispatch'};
    }
    let dispatch: storage.DispatchGrant;
    try {
      dispatch = await storage.authorizeDispatch(resolved.db, holder);
    } catch (error) {
      if (error instanceof storage.GenerationDenied && (error.code === 'cancel_requested' || error.code === 'deadline_passed')) {
        await storage.closeNotSent(resolved.db, holder, error.code === 'cancel_requested' ? 'cancelled' : 'deadline');
        return {jobId: claim.jobId, outcome: 'closed_not_sent', detail: error.code};
      }
      throw error;
    }
    const prepared = reprepareOrThrow(dispatch);
    const outcome = await submitAndRecord(resolved, holder, prepared, client, 'first');
    if (outcome === 'refused') return {jobId: claim.jobId, outcome: 'refused'};
    attempt = await storage.loadAttempt(resolved.db, claim.jobId);
    if (!attempt) throw new Error('generation_worker_defect: attempt vanished after submit');
  } else if (attempt.state === 'dispatch_committed') {
    // Reclaimed after a crash between dispatch commit and outcome recording: the request might
    // have left the process. Never resend blindly; resolve through the unknown path.
    await storage.recordUnknown(resolved.db, holder, 'reclaimed after restart: dispatch outcome was never recorded');
    attempt = await storage.loadAttempt(resolved.db, claim.jobId);
    if (!attempt) throw new Error('generation_worker_defect: attempt vanished after recordUnknown');
  }

  if (attempt.state === 'unknown') {
    const resolution = await resolveUnknownAttempt(resolved, holder, attempt, client, signal);
    if (resolution === 'still_unknown') return {jobId: claim.jobId, outcome: 'unknown_unresolved'};
    if (resolution === 'parked') return {jobId: claim.jobId, outcome: 'needs_operator'};
    if (resolution === 'refused') return {jobId: claim.jobId, outcome: 'refused'};
    attempt = await storage.loadAttempt(resolved.db, claim.jobId);
    if (!attempt) throw new Error('generation_worker_defect: attempt vanished after reconciliation');
  }

  if (attempt.state === 'accepted') {
    if (!attempt.runId) throw new Error('generation_worker_defect: accepted attempt has no run id');
    const ref: CutroomRunRef = {requestId: attempt.requestId, runId: attempt.runId, until: claim.until};
    const followed = await followToTerminal(resolved, holder, ref, client, signal, async () => {
      const job = await storage.loadJob(resolved.db, claim.jobId);
      return Boolean(job?.cancelRequestedAt);
    });
    if (followed === 'aborted') return {jobId: claim.jobId, outcome: 'following_paused'};
    const {jobStatus, enginePath} = await fetchResultAndRecord(resolved, holder, ref, client);
    if (jobStatus === 'importing') {
      if (!enginePath) throw new Error('generation_worker_defect: importing status without a video engine path');
      try {
        const imported = await resolved.importPort.importFinishedVideo({
          attemptId: attempt.id, runId: attempt.runId, enginePath, engineArtifactRoot: engine.artifactRoot,
        });
        resolved.log({service: 'generation-worker', event: 'imported', jobId: claim.jobId, imported});
      } catch (error) {
        resolved.log({
          service: 'generation-worker', event: 'import_not_available', jobId: claim.jobId,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
      return {jobId: claim.jobId, outcome: 'importing'};
    }
    return {jobId: claim.jobId, outcome: jobStatus};
  }

  if (attempt.state === 'finished' && attempt.settlement === 'held') {
    await storage.settle(resolved.db, holder);
    return {jobId: claim.jobId, outcome: 'settled_after_resume'};
  }

  return {jobId: claim.jobId, outcome: `already_${attempt.state}`};
}

/** Claims and processes exactly one ready job, or returns null when there is none. */
export async function runOnce(options: GenerationWorkerOptions, signal?: AbortSignal): Promise<ProcessOutcome | null> {
  const resolved = resolveOptions(options);
  const claim = await storage.claimJob(resolved.db, {owner: resolved.owner, leaseMs: resolved.leaseMs});
  if (!claim) return null;
  return processClaimedJob(options, claim, signal);
}

/** The worker loop's own body, used by `main.ts` and directly by tests that want a bounded run
 * rather than a full process. Stops when `signal` aborts or after `maxIterations` empty polls. */
export async function runLoop(options: GenerationWorkerOptions, signal: AbortSignal, idlePollMs = 500): Promise<void> {
  const resolved = resolveOptions(options);
  while (!signal.aborted) {
    let outcome: ProcessOutcome | null;
    try {
      outcome = await runOnce(options, signal);
    } catch (error) {
      resolved.log({service: 'generation-worker', event: 'error', detail: error instanceof Error ? error.message : String(error)});
      outcome = null;
    }
    if (outcome) resolved.log({service: 'generation-worker', event: 'processed', ...outcome});
    else if (!await sleepUnlessAborted(idlePollMs, signal)) return;
  }
}
