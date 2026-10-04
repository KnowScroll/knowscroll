// Owns the fairness scheduler facade: policy install, enqueue and schedule.
// A probe inspects one head or empty scope per transaction and holds the universe-first lock order.
// Discovery, probing and enqueue live in fairness/ (ADR-0013; docs/operations/reasoning-sql-fairness.md).
import type pg from 'pg';
import { ReasoningDenied, type ReasoningAuthority } from './runtime-policy.ts';
import {
  FAIRNESS_CLASSES,
  validateFairnessPolicy,
  type FairnessClass,
} from './fairness-policy.ts';
import { REASONING_ADMISSION_LIMITS } from './admission.ts';
import type {
  FairnessObservation,
  FairnessNoWork,
  ReasoningFairness,
} from './fairness/types.ts';
import { deny, tx, policyFor } from './fairness/shared.ts';
import { discover } from './fairness/discover.ts';
import {
  lockProbe,
  lockCursor,
  save,
  observation,
  probe,
} from './fairness/probe.ts';
import { enqueueFairInTransaction } from './fairness/enqueue.ts';

export type {
  FairnessNoWork,
  FairnessObservation,
  FairnessReadyInput,
  FairnessScheduleInput,
  FairnessScheduled,
  ReasoningFairness,
} from './fairness/types.ts';
export { enqueueFairInTransaction } from './fairness/enqueue.ts';

export function createReasoningFairness(
  db: pg.Pool,
  authority: ReasoningAuthority,
): ReasoningFairness {
  return {
    async installPolicy(input) {
      const { policy, hash } = validateFairnessPolicy(input);
      await tx(db, async (client) => {
        await client.query(
          `
     INSERT INTO
       reasoning_fairness_policy (version, policy_hash, config)
     VALUES
       ($1, $2, $3)
     ON CONFLICT DO NOTHING
   `,
          [policy.version, hash, JSON.stringify(policy)],
        );
        if ((await policyFor(client, policy.version)).hash !== hash)
          deny('fairness_policy_changed');
        await client.query(
          'INSERT INTO reasoning_fairness_scheduler(policy_version) VALUES($1) ON CONFLICT DO NOTHING',
          [policy.version],
        );
        for (const klass of FAIRNESS_CLASSES)
          await client.query(
            'INSERT INTO reasoning_fairness_class(policy_version,class) VALUES($1,$2) ON CONFLICT DO NOTHING',
            [policy.version, klass],
          );
      });
      return { version: policy.version, hash };
    },
    async enqueue(input) {
      await tx(db, (client) => enqueueFairInTransaction(client, input));
    },
    async schedule(input) {
      if (
        !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/.test(input.owner) ||
        !Number.isInteger(input.leaseMs) ||
        input.leaseMs < 1 ||
        input.leaseMs > REASONING_ADMISSION_LIMITS.maxLeaseMs
      )
        deny('invalid_fairness_lease');
      const { policy } = await policyFor(db, input.policyVersion);
      const observations: FairnessObservation[] = [];
      let lastProgress:
        | { generation: string; klass: FairnessClass }
        | undefined;
      for (let probes = 1; probes <= policy.maxProbes; probes++) {
        const d = await discover(db, input.policyVersion);
        if (d.state.paused)
          return {
            kind: 'policy_paused',
            observations: [...observations, observation(d, 'policy_paused')],
            probes,
          };
        try {
          const result = await probe(db, authority, input, d);
          lastProgress = result.terminalExpiry
            ? undefined
            : {
                generation: (BigInt(d.state.generation) + 1n).toString(),
                klass: d.klass,
              };
          observations.push(result.event);
          if (result.admitted)
            return { ...result.admitted, observations, probes };
        } catch (error) {
          // A context that changed between a head's preflight and its reservation is one more such race.
          if (
            !(error instanceof ReasoningDenied) ||
            !(
              [
                'fairness_cas_retry',
                'fairness_policy_paused',
                'policy_binding_changed',
                'expired_lease_or_job',
              ].includes(error.code) || error.code.startsWith('context_')
            )
          )
            throw error;
          observations.push(
            observation(
              d,
              error.code === 'fairness_policy_paused'
                ? 'policy_paused'
                : 'temporarily_blocked',
              error.code,
            ),
          );
        }
      }
      // A bounded scan cannot establish absence. Yield its current class opportunity
      // without granting a quantum or resetting any unfinished spend allowance.
      const d = await discover(db, input.policyVersion, false);
      try {
        if (
          lastProgress?.generation === d.state.generation &&
          lastProgress.klass === d.klass
        )
          await tx(db, async (client) => {
            await lockProbe(client, input.policyVersion);
            await lockCursor(client, input.policyVersion, d);
            await save(client, input.policyVersion, d, true);
          });
      } catch (error) {
        if (
          !(error instanceof ReasoningDenied) ||
          !['fairness_cas_retry', 'fairness_policy_paused'].includes(error.code)
        )
          throw error;
      }
      const distinct = new Set(observations.map((x) => x.kind));
      const kind =
        distinct.size === 1 && observations[0]!.kind !== 'no_candidate'
          ? observations[0]!.kind
          : 'scan_exhausted';
      return {
        kind: kind as FairnessNoWork['kind'],
        observations: [
          ...observations,
          { kind: 'scan_exhausted', reason: 'probe_budget' },
        ],
        probes: policy.maxProbes,
      };
    },
  };
}
