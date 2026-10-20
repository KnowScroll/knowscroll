import type {
  CartographerPorts,
  GeographyPorts,
  RunCartographer,
  PublishGeographyDelta,
  GeographyRun,
} from './ports.js';
import { GEOGRAPHY_POLICY } from '../domain/policy.js';
import { prepareGeography } from './context.js';
import { cartographerRole, cartographyContextItems } from './role.js';
import { ensureCartography } from './request.js';
import { applyProposal } from './apply.js';
/** Short prepare/apply transactions around the shared attempt ledger; no network under root locks. */
export function makeRunCartographer(p: CartographerPorts): RunCartographer {
  return async (job, signal) => {
    const authority = {
      universeId: job.universeId,
      privacyEpoch: job.privacyEpoch,
      actor: { kind: 'system' as const, purpose: 'geography.cartograph' },
    };
    const prepared = await p.withScope(authority, async (scope) => {
      if (!(await p.ownerActive(scope))) return undefined;
      const state = await p.store.state(scope),
        run = await p.store.run(scope, job.runId);
      if (!run || state.activeRunId !== run.id) return undefined;
      if (job.expectedClaimId && (run.claimId !== job.expectedClaimId || run.status !== 'prepared')) return undefined;
      if (run.claimUntil && Date.parse(run.claimUntil) > p.now().getTime()) {
        if (run.status === 'prepared' && run.claimId)
          await p.enqueue(scope, run.id, {
            expectedClaimId: run.claimId,
            startAfter: new Date(Date.parse(run.claimUntil) + 1000),
          });
        return undefined;
      }
      if (run.status === 'blocked' || run.status === 'unknown') return undefined;
      if (!p.enabled() || !(await p.permitted(scope))) {
        await p.store.writeRun(scope, {
          ...run,
          status: 'blocked',
          outcome: p.enabled() ? 'budget_unavailable' : 'disabled',
        });
        return undefined;
      }
      const context = run.context ?? (await prepareGeography(p, scope, await p.store.view(scope)));
      if (!context) {
        await p.store.writeRun(scope, { ...run, status: 'insufficient', outcome: 'coverage_unavailable' });
        await p.store.writeState(scope, { ...state, activeRunId: undefined });
        return undefined;
      }
      try {
        cartographyContextItems(context);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'GEOGRAPHY_CONTEXT_LIMIT') throw error;
        await p.store.writeRun(scope, { ...run, status: 'insufficient', outcome: 'context_limit' });
        await p.store.writeState(scope, { ...state, activeRunId: undefined });
        return undefined;
      }
      if (!(await p.ownerActive(scope)) || !(await p.permitted(scope))) {
        await p.store.writeRun(scope, { ...run, status: 'blocked', outcome: 'budget_unavailable' });
        return undefined;
      }
      const claimed = {
        ...run,
        desiredRevision: context.desiredRevision,
        status: 'prepared' as const,
        context,
        claimId: p.newId(),
        claimUntil: new Date(p.now().getTime() + 1150000).toISOString(),
      };
      await p.store.writeRun(scope, claimed);
      return claimed;
    });
    if (prepared.kind !== 'entered' || !prepared.value) return;
    const run = prepared.value,
      c = run.context;
    const outcome = await p.harness.propose(
      {
        run: {
          id: run.id,
          authority,
          ownerModule: 'geography',
          purpose: 'personal-cartographer',
          policyVersion: GEOGRAPHY_POLICY,
        },
        role: cartographerRole(c),
        context: { bundleRef: `geography:${run.id}`, items: cartographyContextItems(c) },
        limits: { allowRepair: true },
      },
      signal,
    );
    await p.withScope(authority, async (scope) => {
      if (!(await p.ownerActive(scope))) return;
      const state = await p.store.state(scope),
        current = await p.store.run(scope, run.id);
      if (!current || state.activeRunId !== run.id || current.claimId !== run.claimId || current.status !== 'prepared')
        return;
      const { claimId: _claim, claimUntil: _until, ...released } = current;
      if (
        outcome.kind === 'unknown' ||
        outcome.kind === 'quota_unavailable' ||
        outcome.kind === 'budget_exhausted' ||
        outcome.kind === 'refused'
      ) {
        const unknown = outcome.kind === 'unknown' || current.outcome === 'unknown';
        await p.store.writeRun(scope, {
          ...released,
          status: unknown ? 'unknown' : 'blocked',
          outcome: outcome.kind === 'refused' ? outcome.reason : outcome.kind,
        });
        return;
      }
      let status: GeographyRun['status'] = 'rejected',
        reason: string = outcome.kind;
      if (!(await p.ownerActive(scope)) || !p.enabled() || !(await p.permitted(scope))) {
        status = 'stale';
        reason = 'scope_or_permit_changed';
      } else if (state.desiredRevision !== c.desiredRevision) {
        status = 'stale';
        reason = 'desired_revision_changed';
      } else if (outcome.kind === 'proposed') {
        const result = await applyProposal(p, scope, run.id, c, outcome.output);
        if (result.kind === 'refused') {
          status = result.reason === 'no_changes' ? 'insufficient' : 'stale';
          reason = result.reason;
        } else {
          status = 'accepted';
          reason = 'applied';
        }
      }
      // A refusal/rollback never consumes a new answer: harness closure commits with all geography effects.
      const closed = await p.harness.closeRun(scope, {
        runId: run.id,
        state: status === 'accepted' ? 'completed' : 'cancelled',
      });
      if (status === 'accepted' && closed !== 'closed') throw new Error('GEOGRAPHY_HARNESS_NOT_CLOSED');
      await p.store.writeRun(scope, {
        ...released,
        status,
        outcome: reason,
        ...(outcome.kind === 'proposed' ? { proposal: outcome.output, attemptId: outcome.attemptId } : {}),
      });
      const updated = await p.store.state(scope),
        idle = { ...updated, activeRunId: undefined };
      await p.store.writeState(scope, idle);
      if (updated.desiredRevision > run.desiredRevision) await ensureCartography(p, scope, idle);
    });
  };
}
/** Durable delta was committed before this IDs-only hint job. This is not a scene projection. */
export function makePublishDelta(p: GeographyPorts): PublishGeographyDelta {
  return async (job) => {
    await p.withScope(
      {
        universeId: job.universeId,
        privacyEpoch: job.privacyEpoch,
        actor: { kind: 'system', purpose: 'geography.publish-delta' },
      },
      async (scope) => {
        if (!(await p.ownerActive(scope))) return;
        const receipt = await p.store.findDelta(scope, job.transitionId),
          state = await p.store.state(scope);
        if (
          !receipt ||
          receipt.delta.geography.revision !== job.geographyRevision ||
          state.publishedRevision >= job.geographyRevision
        )
          return;
        await p.notify(scope, scope.revisionAtEntry, job.transitionId);
        await p.store.writeState(scope, { ...state, publishedRevision: job.geographyRevision });
      },
    );
  };
}
