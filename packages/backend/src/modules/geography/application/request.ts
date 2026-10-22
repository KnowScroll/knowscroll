import { z } from 'zod';
import type { RecordingScopeTx } from '../../identity/public.js';
import type { GeographyPorts, GeographyState, MaterialGeographyChange, RequestCartography } from './ports.js';
/** Immutable birth identity from a current accepted source, never a resumed prepare. */
export async function ensureCartography(
  p: Pick<GeographyPorts, 'store' | 'newId' | 'enqueue' | 'enqueueRetirement'>,
  cap: RecordingScopeTx,
  state: GeographyState,
): Promise<GeographyState> {
  const root = await p.store.root(cap);
  if (state.activeRunId) {
    if (state.desiredSource?.generation === cap.generation) await p.enqueueRetirement(cap, state.activeRunId);
    return state;
  }
  if (!state.desiredSource || state.desiredSource.generation !== cap.generation)
    throw new Error('GEOGRAPHY_DESIRED_SOURCE_REQUIRED');
  const activeRunId = p.newId(),
    next = { ...state, activeRunId };
  await p.store.writeRun(cap.personal, {
    id: activeRunId,
    desiredRevision: state.desiredRevision,
    status: 'queued',
    recording: { accountId: root.accountId, source: state.desiredSource },
  });
  await p.store.writeState(cap.personal, next);
  if (!(await p.enqueue(cap, activeRunId))) throw new Error('GEOGRAPHY_REQUIRED_WAKE');
  return next;
}
export function makeGeographyMaterialChange(p: GeographyPorts): MaterialGeographyChange {
  return async (cap, input) => {
    const root = await p.store.root(cap);
    if (
      input.recordingGeneration !== cap.generation ||
      !Number.isSafeInteger(input.sourceRevision) ||
      input.sourceRevision !== cap.personal.revisionAtEntry + 1 ||
      root.revision !== input.sourceRevision
    )
      throw new Error('GEOGRAPHY_MATERIAL_REVISION');
    const state = await p.store.state(cap.personal);
    if (input.sourceRevision <= state.materialRevision) return;
    const next = {
      ...state,
      desiredRevision: state.desiredRevision + 1,
      materialRevision: input.sourceRevision,
      desiredSource: { generation: cap.generation, kind: 'material' as const, sourceRevision: input.sourceRevision },
    };
    await p.store.writeState(cap.personal, next);
    await ensureCartography(p, cap, next);
  };
}
/** Explicit original-body retry/resume. No read or toggle invokes this producer. */
export function makeRequestCartography(p: GeographyPorts): RequestCartography {
  return async (authority, input) => {
    const c = z
      .strictObject({
        commandId: z.uuid(),
        resumeRunId: z.uuid().optional(),
        recordingGeneration: z.number().int().min(1).max(2147483647).optional(),
      })
      .refine((x) => !Object.hasOwn(x, 'recordingGeneration') || x.recordingGeneration !== undefined)
      .parse(input);
    const result = await p.withScope(authority, async (scope) => {
      if ((await p.fenceOwn(scope)).kind !== 'active') return { kind: 'refused', reason: 'scope_refused' } as const;
      const previous = await p.receipts.find(scope, c.commandId, c);
      if (previous.kind === 'replay') return previous.outcome;
      if (previous.kind !== 'new') return { kind: 'refused', reason: 'command_key_reused' } as const;
      await p.receipts.insert(scope, c.commandId, c);
      const refuse = async (reason: 'recording_required' | 'run_not_resumable') => {
        const outcome = { kind: 'refused', reason } as const;
        await p.receipts.complete(scope, c.commandId, outcome);
        return outcome;
      };
      const gate = await p.fenceRecording(scope, c.recordingGeneration);
      if (gate.kind !== 'recording') return refuse('recording_required');
      const cap = gate.scope,
        state = await p.store.state(scope),
        root = await p.store.root(cap);
      let runId: string;
      if (c.resumeRunId) {
        const run = await p.store.header(scope, c.resumeRunId),
          expired = run?.status === 'prepared' && (!run.claimUntil || Date.parse(run.claimUntil) <= p.now().getTime());
        if (
          !run ||
          state.activeRunId !== run.id ||
          (run.claimUntil && Date.parse(run.claimUntil) > p.now().getTime()) ||
          (!['blocked', 'unknown'].includes(run.status) &&
            !expired &&
            !(run.status === 'queued' && run.normalWakeId)) ||
          (!run.recording && cap.generation !== 1) ||
          (run.recording &&
            (run.recording.source.generation !== cap.generation || run.recording.accountId !== root.accountId)) ||
          (run.recording && run.hasContext && (!run.contextSha256 || !run.modelContextSha256))
        )
          return refuse('run_not_resumable');
        if (!(await p.enqueue(cap, run.id))) return refuse('run_not_resumable');
        runId = run.id;
      } else {
        const next = {
          ...state,
          desiredRevision: state.desiredRevision + 1,
          desiredSource: { generation: cap.generation, kind: 'command' as const, commandId: c.commandId },
        };
        await p.store.writeState(scope, next);
        runId = (await ensureCartography(p, cap, next)).activeRunId!;
      }
      const revision = await p.advance(scope),
        current = await p.store.state(scope),
        outcome = {
          kind: 'accepted',
          runId,
          desiredRevision: current.desiredRevision,
          privacyEpoch: scope.authority.privacyEpoch,
          revision,
        } as const;
      await p.receipts.complete(scope, c.commandId, outcome);
      return outcome;
    });
    return result.kind === 'entered' ? result.value : { kind: 'refused', reason: 'scope_refused' };
  };
}
