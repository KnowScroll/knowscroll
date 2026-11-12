import { bestEffort, type BestEffort } from '../../../infrastructure/postgres/best-effort.js';
import type { PersonalScopeTx } from '../../identity/public.js';
import { gapSignalsOf } from '../domain/gap-signals.js';
import { policyOf } from '../domain/policy.js';
import type { PersistComposerDecision, RecordDecisionSignals } from '../application/ports.js';

export interface GapSignalGuard {
  /** Runs the recorder so that it can neither fail nor delay the transaction (a savepoint and a short lock wait); defaults to the real thing. */
  readonly guard?: (scope: PersonalScopeTx, effect: () => Promise<void>) => Promise<BestEffort>;
  /** Told the code of a recorder that failed, which is otherwise swallowed: log it, nothing else. */
  readonly onFailure?: (code: string) => void;
}

/**
 * The persist port, with the signals the decision carries recorded in the same transaction (#674, D-414). The decision is stored exactly as before and
 * the signals are derived from it afterwards, from the stored result alone (`gapSignalsOf` is pure), so nothing about the decision, its input or its
 * replay changes. Only a decision newly stored records: a replay of one that was already stored is not counted again.
 *
 * Recording is best effort and can never fail the navigation that stored the decision: it runs under a savepoint with a short lock wait
 * (`bestEffort`), so an error rolls back only the recorder's own writes and is swallowed (its code goes to `onFailure`), and a row another transaction
 * holds, one the scan is counting, makes it give up at once instead of making the person wait. The recorder is the owner of the counters' own port: this
 * module names no table of it and reads none of it.
 */
export function withGapSignals(
  persist: PersistComposerDecision,
  record: RecordDecisionSignals,
  options: GapSignalGuard = {},
): PersistComposerDecision {
  const guard = options.guard ?? bestEffort;
  return async (scope, binding, decision) => {
    const result = await persist(scope, binding, decision);
    if (result === 'stored') {
      const signals = gapSignalsOf(decision, policyOf(decision.policyVersion).maxCandidates);
      if (signals.length > 0) {
        const outcome = await guard(scope, () => record(scope, signals));
        if (!outcome.ok) options.onFailure?.(outcome.code);
      }
    }
    return result;
  };
}
