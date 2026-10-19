import type { PersonalScopeTx } from '../../modules/identity/public.js';
import { transactionOf } from '../../infrastructure/postgres/personal-scope.js';
import { canTransition, type AttemptState } from '../domain/attempts.js';
import type { AttemptRow, ExecuteModelStepPorts } from '../application/ports.js';

/** Admits a personal business run once; later deliveries find it. */
export async function admitRun(
  scope: PersonalScopeTx,
  run: { readonly id: string; readonly ownerModule: string; readonly purpose: string },
): Promise<void> {
  await transactionOf(scope)
    .insertInto('reasoning.business_runs')
    .values({
      id: run.id,
      owner_module: run.ownerModule,
      purpose: run.purpose,
      universe_id: scope.authority.universeId,
      privacy_epoch: scope.authority.privacyEpoch,
    })
    .onConflict((conflict) => conflict.column('id').doNothing())
    .execute();
}

export async function findAttempt(
  scope: PersonalScopeTx,
  runId: string,
  step: string,
): Promise<AttemptRow | undefined> {
  const row = await transactionOf(scope)
    .selectFrom('reasoning.external_attempts')
    .select(['id', 'state', 'outcome_code'])
    .where('run_id', '=', runId)
    .where('step', '=', step)
    .where('universe_id', '=', scope.authority.universeId)
    .executeTakeFirst();
  return row === undefined
    ? undefined
    : { id: row.id, state: row.state as AttemptState, outcomeCode: row.outcome_code };
}

export const reserveAttempt: ExecuteModelStepPorts['reserveAttempt'] = async (scope, attempt) => {
  await transactionOf(scope)
    .insertInto('reasoning.external_attempts')
    .values({
      id: attempt.id,
      run_id: attempt.runId,
      step: attempt.step,
      universe_id: scope.authority.universeId,
      provider: attempt.provider,
      model: attempt.model,
      request_hash: attempt.requestHash,
    })
    .execute();
};

/** A conditional state change: applies only if the attempt is still in `from`. */
export const transitionAttempt: ExecuteModelStepPorts['transitionAttempt'] = async (
  scope,
  attemptId,
  from,
  to,
  details = {},
) => {
  if (!canTransition(from, to)) throw new Error(`Attempt transition ${from} → ${to} is not allowed`);
  const result = await transactionOf(scope)
    .updateTable('reasoning.external_attempts')
    .set({
      state: to,
      ...(to === 'dispatched' ? { dispatched_at: new Date() } : { settled_at: new Date() }),
      ...(details.remoteId === undefined ? {} : { remote_id: details.remoteId }),
      ...(details.outcomeCode === undefined ? {} : { outcome_code: details.outcomeCode }),
    })
    .where('id', '=', attemptId)
    .where('universe_id', '=', scope.authority.universeId)
    .where('state', '=', from)
    .executeTakeFirst();
  return result.numUpdatedRows === 1n;
};
