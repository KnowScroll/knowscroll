import { z } from 'zod';
import type { PersonalScopeTx } from '../../identity/public.js';
import type { GeographyPorts, GeographyState, MaterialGeographyChange, RequestCartography } from './ports.js';
export async function ensureCartography(
  p: GeographyPorts,
  scope: PersonalScopeTx,
  state: GeographyState,
): Promise<GeographyState> {
  if (state.activeRunId) return state;
  const activeRunId = p.newId(),
    next = { ...state, activeRunId };
  await p.store.writeRun(scope, { id: activeRunId, desiredRevision: state.desiredRevision, status: 'queued' });
  await p.store.writeState(scope, next);
  await p.enqueue(scope, activeRunId);
  return next;
}
export function makeGeographyMaterialChange(p: GeographyPorts): MaterialGeographyChange {
  return async (scope, input) => {
    if (!(await p.ownerActive(scope))) return;
    if (!Number.isSafeInteger(input.sourceRevision) || input.sourceRevision <= scope.revisionAtEntry)
      throw new Error('GEOGRAPHY_MATERIAL_REVISION');
    const state = await p.store.state(scope);
    if (input.sourceRevision <= state.materialRevision) return;
    const next = { ...state, desiredRevision: state.desiredRevision + 1, materialRevision: input.sourceRevision };
    await p.store.writeState(scope, next);
    await ensureCartography(p, scope, next);
  };
}
/** Backend-only explicit same-ID resume. HTTP/resources never invoke this as a polling side effect. */
export function makeRequestCartography(p: GeographyPorts): RequestCartography {
  return async (authority, input) => {
    const c = z.strictObject({ commandId: z.uuid(), resumeRunId: z.uuid().optional() }).parse(input);
    const result = await p.withScope(authority, async (scope) => {
      if (!(await p.ownerActive(scope))) return { kind: 'refused', reason: 'scope_refused' } as const;
      const previous = await p.receipts.find(scope, c.commandId, c);
      if (previous.kind === 'replay') return previous.outcome;
      if (previous.kind !== 'new') return { kind: 'refused', reason: 'command_key_reused' } as const;
      const state = await p.store.state(scope);
      let runId: string;
      if (c.resumeRunId) {
        const run = await p.store.run(scope, c.resumeRunId);
        if (
          !run ||
          state.activeRunId !== run.id ||
          (!['blocked', 'unknown'].includes(run.status) &&
            !(run.status === 'prepared' && (!run.claimUntil || Date.parse(run.claimUntil) <= p.now().getTime())))
        )
          return { kind: 'refused', reason: 'run_not_resumable' } as const;
        const { claimId: _claim, claimUntil: _until, ...released } = run;
        await p.receipts.insert(scope, c.commandId, c);
        await p.store.writeRun(scope, { ...released, status: run.context ? 'prepared' : 'queued' });
        await p.enqueue(scope, run.id);
        runId = run.id;
      } else {
        await p.receipts.insert(scope, c.commandId, c);
        const next = { ...state, desiredRevision: state.desiredRevision + 1 };
        await p.store.writeState(scope, next);
        runId = (await ensureCartography(p, scope, next)).activeRunId!;
      }
      const revision = await p.advance(scope),
        current = await p.store.state(scope);
      const outcome = {
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
