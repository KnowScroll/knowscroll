import { z } from 'zod';
import { IntentSchema } from '../domain/proposal.js';
import type { PlannerMaterialChange, PlannerPorts, PlannerState, RequestPlanner } from './ports.js';
import type { PersonalScopeTx } from '../../identity/public.js';

/** The root lock serialises revision selection and one active role run; pg-boss is the only outbox. */
export async function ensureRun(
  p: Pick<PlannerPorts, 'store' | 'newId' | 'enqueue'>,
  scope: PersonalScopeTx,
  state: PlannerState,
): Promise<PlannerState & { readonly activeRunId: string }> {
  if (state.activeRunId) return { ...state, activeRunId: state.activeRunId };
  const runId = p.newId();
  await p.store.writeRun(scope, { id: runId, revision: state.desiredRevision, status: 'queued' });
  const next = { ...state, activeRunId: runId };
  await p.store.writeState(scope, next);
  await p.enqueue(scope, runId);
  return next;
}
export function makeMaterialChange(p: Pick<PlannerPorts, 'store' | 'newId' | 'enqueue'>): PlannerMaterialChange {
  return async (scope, input) => {
    if (!Number.isSafeInteger(input.sourceRevision) || input.sourceRevision <= scope.revisionAtEntry)
      throw new Error('PLANNER_MATERIAL_REVISION_INVALID');
    const state = await p.store.state(scope);
    if (input.sourceRevision <= state.materialRevision) return;
    const next = { ...state, desiredRevision: state.desiredRevision + 1, materialRevision: input.sourceRevision };
    await p.store.writeState(scope, next);
    await ensureRun(p, scope, next);
  };
}
export function makeRequestPlanner(
  p: Pick<PlannerPorts, 'withPersonalScope' | 'store' | 'newId' | 'enqueue' | 'receipts' | 'hash' | 'now'>,
): RequestPlanner {
  return async (authority, command) => {
    const c = z
      .strictObject({ commandId: z.uuid(), intent: IntentSchema.optional(), resumeRunId: z.uuid().optional() })
      .refine((x) => !(x.intent && x.resumeRunId), 'Resume preserves the frozen intent')
      .parse(command);
    const hash = p.hash({ intent: c.intent ?? null, resumeRunId: c.resumeRunId ?? null });
    const result = await p.withPersonalScope(authority, async (scope) => {
      const receipt = await p.receipts.find(scope, c.commandId, hash);
      if (receipt.kind === 'replay') return receipt.outcome;
      if (receipt.kind !== 'new') return { kind: 'refused', reason: 'command_key_reused' } as const;
      await p.receipts.insert(scope, c.commandId, hash);
      const state = await p.store.state(scope);
      if (c.resumeRunId) {
        const run = await p.store.run(scope, c.resumeRunId);
        const preparedExpired =
          run?.status === 'prepared' && (!run.claimUntil || Date.parse(run.claimUntil) <= p.now().getTime());
        if (
          state.activeRunId !== c.resumeRunId ||
          !run ||
          (!['blocked', 'unknown'].includes(run.status) && !preparedExpired)
        ) {
          const outcome = { kind: 'refused', reason: 'run_not_resumable' } as const;
          await p.receipts.complete(scope, c.commandId, outcome);
          return outcome;
        }
        const { claimId: _claim, claimUntil: _until, ...released } = run;
        // A durable explicit request is the only transition out of a settled blocked/unknown decision.
        await p.store.writeRun(scope, {
          ...released,
          status: run.context ? 'prepared' : 'queued',
          ...(run.status === 'unknown' ? { outcome: 'unknown' } : {}),
        });
        await p.enqueue(scope, c.resumeRunId);
        const outcome = { kind: 'accepted', revision: state.desiredRevision, runId: c.resumeRunId } as const;
        await p.receipts.complete(scope, c.commandId, outcome);
        return outcome;
      }
      const next = { ...state, desiredRevision: state.desiredRevision + 1, ...(c.intent ? { intent: c.intent } : {}) };
      await p.store.writeState(scope, next);
      const active = await ensureRun(p, scope, next);
      const outcome = { kind: 'accepted', revision: active.desiredRevision, runId: active.activeRunId } as const;
      await p.receipts.complete(scope, c.commandId, outcome);
      return outcome;
    });
    return result.kind === 'entered' ? result.value : { kind: 'refused', reason: 'scope_refused' };
  };
}
