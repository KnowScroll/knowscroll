import { gapSignalsOf } from '../domain/gap-signals.js';
import { policyOf } from '../domain/policy.js';
import type { PersistComposerDecision, RecordDecisionSignals } from '../application/ports.js';

/**
 * The persist port, with the signals the decision carries recorded in the same transaction (#674, D-414). The decision is stored exactly
 * as before and the signals are derived from it afterwards, from the stored result alone (`gapSignalsOf` is pure), so nothing about the
 * decision, its input or its replay changes. Only a decision newly stored records: a replay of one that was already stored is not
 * counted again. The recorder is the owner of the counters' own port: this module names no table of it and reads none of it.
 */
export function withGapSignals(
  persist: PersistComposerDecision,
  record: RecordDecisionSignals,
): PersistComposerDecision {
  return async (scope, binding, decision) => {
    const result = await persist(scope, binding, decision);
    if (result === 'stored') {
      const signals = gapSignalsOf(decision, policyOf(decision.policyVersion).maxCandidates);
      if (signals.length > 0) await record(scope, signals);
    }
    return result;
  };
}
