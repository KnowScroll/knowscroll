import { z } from 'zod';
import { wakeAt } from '../domain/pacing.js';
import { IntentSchema } from '../domain/proposal.js';
import type {
  PlannerMaterialChange,
  PlannerPorts,
  PlannerRun,
  PlannerRunHeader,
  PlannerState,
  RequestPlanner,
} from './ports.js';
import type { RecordingScopeTx } from '../../identity/public.js';

/** The run as it is once nobody holds it: no claim and no pending wake. */
export function withoutClaim<T extends PlannerRunHeader | PlannerRun>(run: T) {
  const { normalWakeId: _wake, claimWakeClaimId: _claimWake, claimId: _claim, claimUntil: _until, ...released } = run;
  return released;
}

/**
 * Puts a run that stopped before any model request left back in the queue. This is the one
 * transition an explicit resume and new evidence share: a run that never froze its context starts
 * over as `queued`, one that did continues as `prepared`, and an `unknown` run keeps that mark.
 * The same business run is used, so a paid answer already kept in the ledger is reused, never paid
 * for twice. Returns false while an earlier wake is still in flight.
 */
async function requeueRun(
  p: Pick<PlannerPorts, 'store' | 'enqueue' | 'prepareNormalWake'>,
  cap: RecordingScopeTx,
  run: PlannerRunHeader,
): Promise<boolean> {
  if ((await p.prepareNormalWake(cap, run.id)) !== 'ready') return false;
  await p.store.writeRun(cap.personal, {
    ...withoutClaim(run),
    status: run.hasContext ? 'prepared' : 'queued',
    ...(run.status === 'unknown' ? { outcome: 'unknown' } : {}),
  });
  await p.enqueue(cap, run.id);
  return true;
}

/**
 * New evidence must never leave the person with a run nothing will pick up again.
 * - `queued` / `prepared` with no claim: wake it again.
 * - `blocked` (disabled, no provider, quota, budget, refusal: nothing was sent): requeue it.
 * - `unknown` (a request may have been sent): wake the worker, which retires the run only once its
 *   attempt is settled or old enough (`retireSettledUnknown`), and never resends the attempt.
 */
async function reviveActiveRun(
  p: Pick<PlannerPorts, 'store' | 'enqueue' | 'prepareNormalWake'>,
  cap: RecordingScopeTx,
  run: PlannerRunHeader,
  accountId: string,
): Promise<void> {
  if (run.claimId) return;
  if (run.recording && run.recording.accountId !== accountId) return;
  if (run.status === 'queued' || run.status === 'prepared' || run.status === 'unknown') {
    await p.enqueue(cap, run.id);
    return;
  }
  if (run.status === 'blocked' && !(run.hasContext && (!run.contextSha256 || !run.modelContextSha256)))
    await requeueRun(p, cap, run);
}

/**
 * Makes sure one run exists for the person and is woken. Birth identity comes from an accepted
 * source, never worker preparation or a resumed clock. A `paced` caller (evidence, or a follow-up
 * to a settled run) starts a new run no earlier than `state.nextRunNotBefore`; changes that arrive
 * meanwhile find this run active and coalesce into it. An explicit request is not paced.
 */
export async function ensureRun(
  p: Pick<PlannerPorts, 'store' | 'newId' | 'enqueue' | 'enqueueRetirement' | 'prepareNormalWake' | 'now'>,
  cap: RecordingScopeTx,
  state: PlannerState,
  paced = false,
): Promise<PlannerState & { readonly activeRunId: string }> {
  const root = await p.store.root(cap);
  if (!state.desiredSource || state.desiredSource.generation !== cap.generation)
    throw new Error('PLANNER_DESIRED_SOURCE_REQUIRED');
  if (state.activeRunId) {
    const old = await p.store.accountingHeader(cap.personal, state.activeRunId);
    if (
      old &&
      (old.generation !== undefined ? old.generation !== cap.generation : cap.generation !== 1) &&
      (!old.accountId || old.accountId === root.accountId)
    )
      await p.enqueueRetirement(cap, old.id);
    else if (old?.generation === cap.generation) {
      const current = await p.store.header(cap.personal, old.id);
      if (current) await reviveActiveRun(p, cap, current, root.accountId);
    }
    return { ...state, activeRunId: state.activeRunId };
  }
  const runId = p.newId();
  await p.store.writeRun(cap.personal, {
    id: runId,
    revision: state.desiredRevision,
    status: 'queued',
    recording: { accountId: root.accountId, source: state.desiredSource },
  });
  const next = { ...state, activeRunId: runId };
  await p.store.writeState(cap.personal, next);
  const startAfter = paced ? wakeAt(state.nextRunNotBefore, p.now()) : undefined;
  await p.enqueue(cap, runId, startAfter && { startAfter });
  return next;
}
export function makeMaterialChange(
  p: Pick<PlannerPorts, 'store' | 'newId' | 'enqueue' | 'enqueueRetirement' | 'prepareNormalWake' | 'now'>,
): PlannerMaterialChange {
  return async (cap, input) => {
    const root = await p.store.root(cap);
    if (
      input.recordingGeneration !== cap.generation ||
      !Number.isSafeInteger(input.sourceRevision) ||
      input.sourceRevision !== cap.personal.revisionAtEntry + 1 ||
      root.revision !== input.sourceRevision
    )
      throw new Error('PLANNER_MATERIAL_REVISION_INVALID');
    const state = await p.store.state(cap.personal);
    if (input.sourceRevision <= state.materialRevision) return;
    const next = {
      ...state,
      desiredRevision: state.desiredRevision + 1,
      materialRevision: input.sourceRevision,
      desiredSource: { generation: cap.generation, kind: 'material' as const, sourceRevision: input.sourceRevision },
    };
    await p.store.writeState(cap.personal, next);
    await ensureRun(p, cap, next, true);
  };
}
export function makeRequestPlanner(
  p: Pick<
    PlannerPorts,
    | 'withPersonalScope'
    | 'fenceOwn'
    | 'fenceRecording'
    | 'store'
    | 'newId'
    | 'enqueue'
    | 'enqueueRetirement'
    | 'prepareNormalWake'
    | 'receipts'
    | 'hash'
    | 'now'
    | 'canonicalHash'
  >,
): RequestPlanner {
  return async (authority, command) => {
    const c = z
      .strictObject({
        commandId: z.uuid(),
        intent: IntentSchema.optional(),
        resumeRunId: z.uuid().optional(),
        recordingGeneration: z.number().int().min(1).max(2147483647).optional(),
      })
      .refine((x) => !(x.intent && x.resumeRunId), 'Resume preserves frozen intent')
      .refine(
        (x) => !Object.hasOwn(x, 'recordingGeneration') || x.recordingGeneration !== undefined,
        'Supplied generation must be concrete',
      )
      .parse(command);
    const hash = p.hash({
      intent: c.intent ?? null,
      resumeRunId: c.resumeRunId ?? null,
      ...(Object.hasOwn(c, 'recordingGeneration') ? { recordingGeneration: c.recordingGeneration } : {}),
    });
    const result = await p.withPersonalScope(authority, async (scope) => {
      if ((await p.fenceOwn(scope)).kind !== 'active') return { kind: 'refused', reason: 'scope_refused' } as const;
      const receipt = await p.receipts.find(scope, c.commandId, hash);
      if (receipt.kind === 'replay') return receipt.outcome;
      if (receipt.kind !== 'new') return { kind: 'refused', reason: 'command_key_reused' } as const;
      await p.receipts.insert(scope, c.commandId, hash);
      const gate = await p.fenceRecording(scope, c.recordingGeneration);
      if (gate.kind !== 'recording') {
        const outcome = { kind: 'refused', reason: 'recording_required' } as const;
        await p.receipts.complete(scope, c.commandId, outcome);
        return outcome;
      }
      const cap = gate.scope,
        state = await p.store.state(scope),
        root = await p.store.root(cap);
      if (c.resumeRunId) {
        const run = await p.store.header(scope, c.resumeRunId);
        const expired =
          run?.status === 'prepared' && (!run.claimUntil || Date.parse(run.claimUntil) <= p.now().getTime());
        if (
          state.activeRunId !== c.resumeRunId ||
          !run ||
          (run.recording && run.hasContext && (!run.contextSha256 || !run.modelContextSha256)) ||
          (!run.recording && (cap.generation !== 1 || run.hasRecordingMetadata)) ||
          (run.recording &&
            (run.recording.source.generation !== cap.generation || run.recording.accountId !== root.accountId)) ||
          (!['blocked', 'unknown'].includes(run.status) && !expired && !(run.status === 'queued' && run.normalWakeId))
        ) {
          const outcome = { kind: 'refused', reason: 'run_not_resumable' } as const;
          await p.receipts.complete(scope, c.commandId, outcome);
          return outcome;
        }
        // An unknown keeps the same business identity. The harness alone reconciles its attempt;
        // explicit resume cannot retag/reissue it or permit an unproved successor.
        if (!(await requeueRun(p, cap, run))) {
          const outcome = { kind: 'refused', reason: 'run_not_resumable' } as const;
          await p.receipts.complete(scope, c.commandId, outcome);
          return outcome;
        }
        const outcome = { kind: 'accepted', revision: state.desiredRevision, runId: run.id } as const;
        await p.receipts.complete(scope, c.commandId, outcome);
        return outcome;
      }
      const next = {
        ...state,
        desiredRevision: state.desiredRevision + 1,
        desiredSource: { generation: cap.generation, kind: 'command' as const, commandId: c.commandId },
        ...(c.intent ? { intent: c.intent } : {}),
      };
      await p.store.writeState(scope, next);
      const active = await ensureRun(p, cap, next);
      const outcome = { kind: 'accepted', revision: active.desiredRevision, runId: active.activeRunId } as const;
      await p.receipts.complete(scope, c.commandId, outcome);
      return outcome;
    });
    return result.kind === 'entered' ? result.value : { kind: 'refused', reason: 'scope_refused' };
  };
}
