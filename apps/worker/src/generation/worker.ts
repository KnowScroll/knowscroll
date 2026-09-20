/** ADR-0023 section 6: the generation worker loop. Claims a job, authorizes exactly one POST,
 * records the outcome, follows events to a terminal run, fetches the result and settles, and (#94
 * stage A2) hands a completed video off to the real verified-import port: a successful import
 * completes the job, a typed refusal leaves it honestly `importing` and retryable, and a missing
 * port is a wiring defect, not a fabricated outcome either way. Holds no provider credentials;
 * talks to Cutroom only through the pinned, unwired HTTP client. Never holds a database
 * transaction across an HTTP call. */
import type pg from 'pg';
import {createCutroomHttpClient, prepareCutroomRequest, type CutroomRunRef} from '../cutroom/http-client.ts';
import {createUnimplementedImportPort, type ImportOutcome, type ImportPort} from './import-port.ts';
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
  /** Test-only crash-injection hook (issue #94 J005 S2): called once, right after dispatch
   * authorization commits and before the first submit is ever sent. `main.ts` wires this from
   * `GENERATION_HOLD_BEFORE_SUBMIT=1` so a harness can SIGKILL the process at a reproducible point
   * between "dispatch committed" and "any outcome recorded" — mirroring Cutroom's own
   * `holdAtCall` design. Defaults to a no-op; never used by ordinary operation. */
  holdBeforeSubmit?: (context: {jobId: string}) => Promise<void>;
};

export type ProcessOutcome = {jobId: string; outcome: string; detail?: string};

type Resolved = Required<Pick<GenerationWorkerOptions, 'db' | 'owner' | 'leaseMs' | 'pollMs' | 'maxFollowIterations' | 'maxLookupRetries' | 'importPort' | 'holdBeforeSubmit'>> & {log: (line: Record<string, unknown>) => void};

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
    holdBeforeSubmit: options.holdBeforeSubmit ?? (async () => {}),
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

/**
 * Fetches the terminal result and record, then settles — EXCEPT for a completed video result
 * (`jobStatus === 'importing'`), whose settlement `handleImport` performs itself, only once a real
 * import actually succeeds. Per ADR-0023 section 3, "a missing or unverifiable result keeps the
 * whole reservation held"; an unimported video result is not yet verified, so its reservation stays
 * held (and its `cutroom_attempt.settlement` stays `held`) until import either succeeds (settled)
 * or the job is honestly abandoned. Every other terminal outcome needs no import and settles here,
 * immediately, exactly as before this stage.
 */
async function fetchResultAndRecord(resolved: Resolved, holder: Holder, ref: CutroomRunRef, client: ReturnType<typeof createCutroomHttpClient>): Promise<{jobStatus: string}> {
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

  if (jobStatus !== 'importing') await storage.settle(resolved.db, holder);
  return {jobStatus};
}

type EngineInfo = {origin: string; artifactRoot: string; providerMode: string};

/**
 * ADR-0023 section 4 / issue #94 stage A2: verified import for a finished, completed video
 * attempt. Called both right after a fresh `run.finished` (from `processClaimedJob`'s own follow)
 * and on a later lease reclaim of a job still sitting `importing` (the attempt is already
 * `finished`/`settled` in that case; only the import itself is retried). Never marks the job
 * `completed` without a real committed `media_object`/`generated_reel` row, and never invents a
 * request id or resends to Cutroom: this step only ever reads the attempt's own persisted result.
 */
async function handleImport(
  resolved: Resolved,
  holder: Holder,
  claim: {jobId: string; briefId: string; engineId: string},
  engine: EngineInfo,
  attempt: storage.AttemptSnapshot,
): Promise<ProcessOutcome> {
  const result = attempt.result as {status?: string; until?: string; video?: {path?: string}} | null;
  const enginePath = result?.status === 'completed' && result.until === 'video' ? result.video?.path : undefined;
  if (!attempt.runId || !enginePath) {
    throw new Error('generation_worker_defect: importing job has no finished completed-video result to import');
  }

  let imported: ImportOutcome;
  try {
    imported = await resolved.importPort.importFinishedVideo({
      attemptId: attempt.id, runId: attempt.runId, enginePath, engineArtifactRoot: engine.artifactRoot,
    });
  } catch (error) {
    // A missing/broken port is a wiring defect, never a data refusal: leave the job honestly
    // `importing` with no status_detail change, so a later reclaim (once a real port is wired or
    // whatever broke it is fixed) tries again from scratch.
    resolved.log({
      service: 'generation-worker', event: 'import_not_available', jobId: claim.jobId,
      detail: error instanceof Error ? error.message : String(error),
    });
    return {jobId: claim.jobId, outcome: 'importing'};
  }

  if (!imported.ok) {
    await storage.recordImportRefusal(resolved.db, holder, `import_refused:${imported.reason}`);
    resolved.log({service: 'generation-worker', event: 'import_refused', jobId: claim.jobId, reason: imported.reason});
    return {jobId: claim.jobId, outcome: 'import_refused', detail: imported.reason};
  }

  const briefSha256 = await storage.briefSha256Of(resolved.db, claim.briefId);
  const committed = await storage.commitImportedReel(resolved.db, {
    attemptId: attempt.id, briefId: claim.briefId, engineId: claim.engineId, cutroomRunId: attempt.runId,
    providerMode: engine.providerMode === 'live' ? 'live' : 'standin',
    enginePath,
    media: {sha256: imported.sha256, byteSize: imported.byteSize, probe: imported.probe, storageKey: imported.storageKey},
    lineage: {briefSha256, contractRevision: attempt.contractRevision, runId: attempt.runId, recordSummary: attempt.recordSummary},
  });
  if (!committed.ok) {
    // The imported file is real and verified, but the database will not link it to this job's
    // lineage (a defect in our own bookkeeping, never Cutroom's fault): record it as a typed,
    // retryable refusal rather than ever fabricating a generated_reel row. The reservation stays
    // held, exactly as an import-refused attempt (ADR-0023: "a missing or unverifiable result
    // keeps the whole reservation held").
    await storage.recordImportRefusal(resolved.db, holder, `import_refused:${committed.reason}`);
    resolved.log({service: 'generation-worker', event: 'import_refused', jobId: claim.jobId, reason: committed.reason});
    return {jobId: claim.jobId, outcome: 'import_refused', detail: committed.reason};
  }

  // Only now — a real, containment-checked, hashed and probed file is durably recorded as this
  // job's generated Reel — is the reported cost actually verified. Settle before marking the job
  // completed, so a job never reaches `completed` with its reservation still `held`.
  if (attempt.settlement === 'held') await storage.settle(resolved.db, holder);
  await storage.completeImportedJob(resolved.db, holder);
  resolved.log({
    service: 'generation-worker', event: 'imported', jobId: claim.jobId,
    generatedReelId: committed.generatedReelId, created: committed.created, storageKey: imported.storageKey,
  });
  return {jobId: claim.jobId, outcome: 'completed'};
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
    await resolved.holdBeforeSubmit({jobId: claim.jobId});
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
    const {jobStatus} = await fetchResultAndRecord(resolved, holder, ref, client);
    if (jobStatus === 'importing') {
      const finished = await storage.loadAttempt(resolved.db, claim.jobId);
      if (!finished) throw new Error('generation_worker_defect: attempt vanished after recordResult');
      return handleImport(resolved, holder, claim, engine, finished);
    }
    return {jobId: claim.jobId, outcome: jobStatus};
  }

  if (attempt.state === 'finished') {
    if (claim.status === 'importing') {
      // Settlement for a video job is deferred to a successful import (see `handleImport` and
      // `fetchResultAndRecord`): never settle here ahead of knowing whether the import succeeds.
      const fresh = await storage.loadAttempt(resolved.db, claim.jobId);
      return handleImport(resolved, holder, claim, engine, fresh ?? attempt);
    }
    if (attempt.settlement === 'held') await storage.settle(resolved.db, holder);
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
