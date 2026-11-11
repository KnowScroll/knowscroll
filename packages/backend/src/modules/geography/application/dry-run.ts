import {
  withScopeAtCurrentEpoch,
  type PersonalScopeTx,
  type ReadPersonalRecordingNow,
  type RecordingScopeTx,
  type ScopeRefusal,
  type WithDryRunPersonalScope,
} from '../../identity/public.js';
import { shapeGeographyDryRun, type GeographyDryRunFacts, type GeographyDryRunReport } from '../domain/dry-run.js';
import { evaluationOf, nothingTrusted, prepareGeography, type PreparationPorts } from './context.js';
import type { GeographyPorts } from './ports.js';
import { modelContextItems } from './role.js';

/**
 * Dependencies of the dry run: the ports a Cartographer run freezes its context with, plus where
 * recording stands and whether the role is switched on. `withScope` must be the read-only,
 * always-rolled-back scope (`makeWithDryRunPersonalScope`): it is what makes the dry run unable to write,
 * whatever a later change to the code a run shares with it does, and the type refuses an ordinary scope.
 */
export interface GeographyDryRunPorts extends PreparationPorts, Pick<GeographyPorts, 'fenceRecording'> {
  readonly withScope: WithDryRunPersonalScope;
  readonly readRecordingNow: ReadPersonalRecordingNow;
  /** The `KS_CARTOGRAPHER_ENABLED` switch. */
  readonly enabled: () => boolean;
}

export type GeographyDryRunResult =
  | { readonly kind: 'read'; readonly report: GeographyDryRunReport }
  | { readonly kind: 'refused'; readonly refusal: ScopeRefusal['kind'] };

/** Shell operator command (`geography dry-run --universe <uuid>`). */
export type GeographyDryRun = (universeId: string) => Promise<GeographyDryRunResult>;

/** A coded fault thrown while freezing a context. Anything else is not ours to name and propagates. */
const FAULT_CODE = /^GEOGRAPHY_[A-Z_]{3,60}$/;

/** Where recording stands under the held root, as a run would find it before it reads anything private. */
async function recordingGate(
  p: GeographyDryRunPorts,
  scope: PersonalScopeTx,
): Promise<
  { readonly kind: 'open'; readonly cap: RecordingScopeTx } | { readonly kind: 'not_runnable' | 'recording_paused' }
> {
  const now = await p.readRecordingNow(scope);
  if (now.kind !== 'recording') return { kind: now.kind === 'paused' ? 'recording_paused' : 'not_runnable' };
  const fenced = await p.fenceRecording(scope, now.generation);
  return fenced.kind === 'recording' ? { kind: 'open', cap: fenced.scope } : { kind: 'not_runnable' };
}

/**
 * What a Cartographer run would do for one universe now, without doing it (D-411). It enters the
 * universe's personal scope (the root lock a read takes), freezes a context exactly as the run does
 * (`prepareGeography`: the same dirty topics, trusted read and facts, plus the topics of the places a quiet settle would look
 * at by the clock), applies the same pure rules (`dueCreations`, `activityChanges`) and rolls back. The scope is read-only, so the run cannot
 * write; it enqueues nothing and calls no model.
 *
 * Output: counts and codes only (`shapeGeographyDryRun`); the outcome is the code a real run records. A fault the
 * context code throws with a `GEOGRAPHY_*` code is reported as `would_fail`; any other error propagates.
 * Failure and retry: safe to run at any time and as often as wanted. It waits for the root lock like a
 * read and gives up with `ScopeBusyError` at the lock timeout.
 */
export function makeGeographyDryRun(p: GeographyDryRunPorts): GeographyDryRun {
  return async (universeId) => {
    const entered = await withScopeAtCurrentEpoch(p.withScope, universeId, 'geography.dry-run', async (scope) => {
      const gate = await recordingGate(p, scope);
      const closed: GeographyDryRunFacts = {
        gate: gate.kind === 'open' ? 'open' : gate.kind,
        roleEnabled: p.enabled(),
        places: undefined,
        routes: undefined,
        refusal: undefined,
        prepared: undefined,
        failureCode: undefined,
      };
      if (gate.kind !== 'open') return closed;
      const structure = await p.store.structure(scope);
      const stored = { ...closed, places: structure.objects, routes: structure.relations };
      try {
        // What a run takes (the dirty topics) and what the quiet settle would take (the places due by this clock).
        const prepared = await prepareGeography(p, gate.cap, { kind: 'dirty', alsoDueBy: p.now() }, { readOnly: true });
        if (prepared.kind === 'unavailable') return { ...stored, refusal: prepared.reason };
        const { context } = prepared;
        const items = modelContextItems(context);
        return {
          ...stored,
          prepared: {
            formation: context.facts,
            topicsEvaluated: evaluationOf(context).topics.length,
            candidateKeys: context.probes.length,
            witnessesHeld: context.coverage.witnesses.length,
            supportKeys: prepared.supportKeys,
            nothingTrusted: nothingTrusted(context),
            contextBytes: new TextEncoder().encode(JSON.stringify(context)).byteLength,
            modelItems: items === undefined ? ('too_large' as const) : items.length,
          },
        };
      } catch (error) {
        if (!(error instanceof Error) || !FAULT_CODE.test(error.message)) throw error;
        return { ...stored, failureCode: error.message };
      }
    });
    if (entered.kind === 'refused') return { kind: 'refused', refusal: entered.refusal.kind };
    return { kind: 'read', report: shapeGeographyDryRun(entered.value) };
  };
}
