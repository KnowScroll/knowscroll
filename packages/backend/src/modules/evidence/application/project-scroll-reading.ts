import { SCROLL_QUALIFICATION_POLICY_V0 } from '../domain/policy.js';
import { qualifyScrollReading } from '../domain/qualification.js';
import { summariseReading, type ObservationRecord } from '../domain/reading-summary.js';
import type { ProjectScrollReadingPayload } from '../events.js';
import { observationBody } from './observation-bodies.js';
import type { ProjectScrollReadingPorts } from './ports.js';

export type ProjectScrollReadingResult =
  | {
      readonly kind: 'applied';
      readonly evidenceId: string;
      readonly revision: number;
      readonly qualification: 'qualified' | 'not_qualified' | 'unknown';
    }
  | {
      readonly kind: 'skipped';
      readonly reason:
        | 'already_applied'
        | 'exposure_missing'
        | 'exposure_not_active'
        | 'facts_missing'
        | 'no_observations'
        | 'epoch_changed'
        | 'universe_unavailable';
    };

/**
 * Consumer of `evidence.project-scroll-reading` (worker; non-transactional: it opens its own short
 * transaction). Projects an exposure's observations into its reading summary and §8 qualification
 * and commits an evidence revision, then hints the account's sockets.
 *
 * Authority: a `system` actor for the payload's universe at the payload's privacy epoch, rechecked
 *   under the personal lock (workers have no HTTP guard, blueprint §19); work for an older epoch is
 *   skipped, never applied. The exposure must still exist at that epoch and be active.
 * Steps (one transaction): lock → read the exposure, its revision's reading facts and its
 *   observations in intake order → if the latest revision already covers this watermark under this
 *   policy, stop (`already_applied`) → summarise (unique visible time, active dwell, interactions,
 *   sequence gaps) and qualify with the versioned policy → insert the revision keyed `(exposure,
 *   input watermark, policy version)` (a conflict is a redelivery: no-op) → advance the universe
 *   revision and `pg_notify` it → commit. The hint is disposable: a client that misses it reads the
 *   durable state when it next refetches.
 * Side effects: `evidence.encounter_evidence`, `identity.universes.revision`, one disposable hint.
 *   No network call, no model call.
 * Failure/retry: any exception rolls everything back and pg-boss redelivers; the unique key makes a
 *   second delivery harmless. The job always projects the exposure's *current* watermark, so a late
 *   job still reflects every observation committed before it.
 * Invariants: only the lineage the intake validated reaches here; unknown or corrupt observations
 *   contribute nothing.
 */
export function makeProjectScrollReading(ports: ProjectScrollReadingPorts) {
  return async function projectScrollReading(
    payload: ProjectScrollReadingPayload,
  ): Promise<ProjectScrollReadingResult> {
    const authority = {
      universeId: payload.universeId,
      privacyEpoch: payload.privacyEpoch,
      actor: { kind: 'system', purpose: 'evidence.project-scroll-reading' },
    } as const;
    const policy = SCROLL_QUALIFICATION_POLICY_V0;
    const entered = await ports.withPersonalScope(authority, async (scope): Promise<ProjectScrollReadingResult> => {
      const exposure = await ports.readExposure(scope, payload.exposureId);
      if (exposure === undefined || exposure.privacyEpoch !== payload.privacyEpoch)
        return { kind: 'skipped', reason: 'exposure_missing' };
      if (exposure.activatedAt === undefined) return { kind: 'skipped', reason: 'exposure_not_active' };
      const facts = await ports.readReadingFacts(scope, exposure.assetId, exposure.assetRevision);
      if (facts === undefined) return { kind: 'skipped', reason: 'facts_missing' };
      const stored = await ports.readObservations(scope, exposure.id);
      const observations: ObservationRecord[] = [];
      for (const row of stored) {
        const body = observationBody(row.kind, row.payload);
        if (body === undefined) continue;
        observations.push({
          seq: row.seq,
          sessionId: row.sessionId,
          deviceSequence: row.deviceSequence,
          instrumentationVersion: row.instrumentationVersion,
          body,
        });
      }
      if (observations.length === 0) return { kind: 'skipped', reason: 'no_observations' };

      const summary = summariseReading(observations, facts, policy);
      const latest = await ports.readLatestEvidence(scope, exposure.id);
      if (
        latest !== undefined &&
        latest.inputWatermark === summary.inputWatermark &&
        latest.policyVersion === policy.version
      )
        return { kind: 'skipped', reason: 'already_applied' };

      const result = qualifyScrollReading(summary, policy);
      const evidenceId = ports.newId();
      const revision = (latest?.revision ?? 0) + 1;
      const inserted = await ports.insertEvidence(scope, {
        id: evidenceId,
        exposureId: exposure.id,
        revision,
        inputWatermark: summary.inputWatermark,
        policyVersion: policy.version,
        qualification: result.qualification,
        q: result.q,
        coverage: result.coverage,
        activeDwellMs: result.activeDwellMs,
        estimatedReadingMs: result.estimatedReadingMs,
        assetId: exposure.assetId,
        assetRevision: exposure.assetRevision,
        summary: {
          v: 1,
          seenBlocks: summary.seenBlocks,
          seenWeight: summary.seenWeight,
          totalWeight: summary.totalWeight,
          dwellRatio: result.dwellRatio,
          interactions: summary.interactions,
          coverageEvents: summary.coverageEvents,
          dwellEvents: summary.dwellEvents,
          instrumentationVersion: summary.instrumentationVersion,
          sequenceGaps: summary.sequenceGaps,
          reasons: result.reasons,
        },
      });
      if (!inserted) return { kind: 'skipped', reason: 'already_applied' };
      const universeRevision = await ports.advanceRevision(scope);
      await ports.notifyScopeChanged(scope, { revision: universeRevision, eventId: evidenceId });
      return { kind: 'applied', evidenceId, revision, qualification: result.qualification };
    });
    if (entered.kind === 'entered') return entered.value;
    return {
      kind: 'skipped',
      reason: entered.refusal.kind === 'epoch_changed' ? 'epoch_changed' : 'universe_unavailable',
    };
  };
}

export type ProjectScrollReading = ReturnType<typeof makeProjectScrollReading>;
