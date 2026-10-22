import { z } from 'zod';
import { plannerContextHashes } from './role.js';
import { IntentSchema } from '../domain/proposal.js';
import type { PlannerMaterialChange, PlannerPorts, PlannerState, RequestPlanner } from './ports.js';
import type { RecordingScopeTx } from '../../identity/public.js';

/** Birth identity comes from an accepted source, never worker preparation or a resumed clock. */
export async function ensureRun(
  p: Pick<PlannerPorts, 'store' | 'newId' | 'enqueue'>,
  cap: RecordingScopeTx,
  state: PlannerState,
): Promise<PlannerState & { readonly activeRunId: string }> {
  const root = await p.store.root(cap);
  if (state.activeRunId) return { ...state, activeRunId: state.activeRunId };
  if (!state.desiredSource || state.desiredSource.generation !== cap.generation)
    throw new Error('PLANNER_DESIRED_SOURCE_REQUIRED');
  const runId = p.newId();
  await p.store.writeRun(cap.personal, {
    id: runId,
    revision: state.desiredRevision,
    status: 'queued',
    recording: { accountId: root.accountId, source: state.desiredSource },
  });
  const next = { ...state, activeRunId: runId };
  await p.store.writeState(cap.personal, next);
  await p.enqueue(cap, runId);
  return next;
}
export function makeMaterialChange(p: Pick<PlannerPorts, 'store' | 'newId' | 'enqueue'>): PlannerMaterialChange {
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
    await ensureRun(p, cap, next);
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
          run.normalWakeId !== undefined ||
          (run.recording && run.hasContext && (!run.contextSha256 || !run.modelContextSha256)) ||
          (!run.recording && cap.generation !== 1) ||
          (run.recording &&
            (run.recording.source.generation !== cap.generation || run.recording.accountId !== root.accountId)) ||
          (!['blocked', 'unknown'].includes(run.status) && !expired)
        ) {
          const outcome = { kind: 'refused', reason: 'run_not_resumable' } as const;
          await p.receipts.complete(scope, c.commandId, outcome);
          return outcome;
        }
        // An unknown keeps the same business identity. The harness alone reconciles its attempt;
        // explicit resume cannot retag/reissue it or permit an unproved successor.
        const {
          claimId: _claim,
          claimUntil: _until,
          claimWakeClaimId: _wake,
          normalWakeId: _normal,
          ...released
        } = run;
        const legacyContext = !run.recording && run.hasContext ? await p.store.context(scope, run.id) : undefined;
        const legacyHashes = legacyContext ? plannerContextHashes(legacyContext, run.id, p.canonicalHash) : undefined;
        await p.store.writeRun(scope, {
          ...released,
          ...(legacyHashes
            ? { contextSha256: legacyHashes.contextSha256, modelContextSha256: legacyHashes.modelContextSha256 }
            : {}),
          recording: run.recording ?? { accountId: root.accountId, source: { generation: 1, kind: 'legacy1' } },
          status: run.hasContext ? 'prepared' : 'queued',
          ...(run.status === 'unknown' ? { outcome: 'unknown' } : {}),
        });
        await p.enqueue(cap, run.id);
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
