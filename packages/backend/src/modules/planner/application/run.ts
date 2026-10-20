import { z } from 'zod';
import {
  diversify,
  opportunityIssue,
  PLANNER_POLICY,
  type Opportunity,
  type ValidationFacts,
} from '../domain/proposal.js';
import type { PersonalScopeTx } from '../../identity/public.js';
import type {
  FrozenContext,
  PlannerPorts,
  PlannerReadPorts,
  PlannerRun,
  ReadPlannerOpportunities,
  RunPlanner,
} from './ports.js';
import { prepareContext } from './context.js';
import { ensureRun } from './request.js';
import { plannerContextItems, plannerRole } from './role.js';

async function currentFacts(
  p: PlannerReadPorts,
  scope: PersonalScopeTx,
  c: FrozenContext,
  opportunities: readonly Opportunity[],
) {
  const snapshot = await p.readSnapshot(scope, {
    evaluatedAt: p.now().toISOString(),
    topicIds: [...c.facts.topics],
    candidates: c.snapshot.qualified.map((q) => ({ explanationUnitId: q.explanationUnitId, facets: [] })),
    candidateAssetIds: c.facts.inventory.map((a) => a.assetId),
    provisionalLimit: 0,
  });
  const inventory: ValidationFacts['inventory'][number][] = [];
  for (const x of opportunities) {
    if (x.target.kind !== 'existing') continue;
    const a = await p.readExact(scope, {
      assetId: x.target.assetId,
      assetRevision: x.target.assetRevision,
      capabilities: p.capabilities,
    });
    if (a) inventory.push({ ...a, topicIds: a.topics.filter((t) => t.role !== 'incidental').map((t) => t.topicId) });
  }
  const evidence = snapshot.supportingEvidence
    .filter((x) => x.qualified)
    .map((x) => ({
      ref: `e:${x.exposureId}:${p.hash(x)}`,
      explanationUnitId: x.explanationUnitId,
      topicIds: x.topics.filter((t) => t.role !== 'incidental').map((t) => t.topicId),
    }));
  return {
    revision: snapshot.revision,
    facts: {
      ...c.facts,
      evaluatedAt: p.now().toISOString(),
      inventory,
      evidence,
      hiddenAssetIds: snapshot.routing.hiddenAssetIds,
    },
  };
}
export function makeRunPlanner(p: PlannerPorts): RunPlanner {
  return async (payload, signal) => {
    const authority = {
      universeId: payload.universeId,
      privacyEpoch: payload.privacyEpoch,
      actor: { kind: 'system', purpose: 'planner.run' },
    } as const;
    const preparation = await p.withPersonalScope(authority, async (scope) => {
      const state = await p.store.state(scope),
        run = await p.store.run(scope, payload.runId);
      if (!run || state.activeRunId !== run.id) return { kind: 'not_active' } as const;
      if (run.claimUntil && Date.parse(run.claimUntil) > p.now().getTime()) return { kind: 'already_running' } as const;
      if (!p.enabled()) {
        if (run.status !== 'unknown')
          await p.store.writeRun(scope, { ...run, status: 'blocked', outcome: 'blocked_disabled' });
        return { kind: 'blocked_disabled' } as const;
      }
      // A redelivery always resumes the frozen context and stable run ID, including unknowns.
      if (run.context) {
        const claimed = {
          ...run,
          context: run.context,
          claimId: p.newId(),
          claimUntil: new Date(p.now().getTime() + 950000).toISOString(),
        };
        await p.store.writeRun(scope, claimed);
        return { kind: 'prepared', run: claimed } as const;
      }
      const context = await prepareContext(p, scope, state);
      try {
        plannerContextItems(context);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'PLANNER_CONTEXT_TOO_LARGE') throw error;
        await p.store.writeRun(scope, {
          ...run,
          revision: state.desiredRevision,
          status: 'insufficient',
          outcome: 'context_bounds',
        });
        const { activeRunId: _active, ...idle } = state;
        await p.store.writeState(scope, idle);
        return { kind: 'context_bounds' } as const;
      }
      const prepared = {
        ...run,
        revision: state.desiredRevision,
        status: 'prepared' as const,
        claimId: p.newId(),
        claimUntil: new Date(p.now().getTime() + 950000).toISOString(),
        context,
      };
      await p.store.writeRun(scope, prepared);
      return { kind: 'prepared', run: prepared } as const;
    });
    if (preparation.kind !== 'entered' || preparation.value.kind !== 'prepared') return preparation;
    const run = preparation.value.run;
    const context = run.context;
    const outcome =
      context.facts.evidence.length === 0
        ? undefined
        : await p.harness.propose(
            {
              run: {
                id: run.id,
                authority,
                ownerModule: 'planner',
                purpose: 'personal-planner',
                policyVersion: PLANNER_POLICY,
              },
              role: plannerRole(context),
              context: { bundleRef: `planner:${run.id}`, items: plannerContextItems(context) },
              limits: { allowRepair: true },
            },
            signal,
          );
    return p.withPersonalScope(authority, async (scope) => {
      const state = await p.store.state(scope),
        current = await p.store.run(scope, run.id);
      if (
        !current ||
        state.activeRunId !== run.id ||
        current.claimId !== run.claimId ||
        !['prepared', 'unknown', 'blocked'].includes(current.status)
      )
        return { kind: 'already_finished' };
      const { claimId: _claim, claimUntil: _until, ...released } = current;
      if (outcome?.kind === 'unknown' || outcome?.kind === 'quota_unavailable') {
        await p.store.writeRun(scope, {
          ...released,
          status: outcome.kind === 'unknown' ? 'unknown' : 'blocked',
          outcome: outcome.kind,
        });
        return { kind: outcome.kind };
      }
      // Admission refusals have no completion; require explicit same-ID resume after policy/config changes.
      if (
        outcome?.kind === 'budget_exhausted' ||
        (outcome?.kind === 'refused' &&
          ['provider_unavailable', 'failure_brake', 'dispatch_lost'].includes(outcome.reason))
      ) {
        await p.store.writeRun(scope, {
          ...released,
          status: 'blocked',
          outcome: outcome.kind === 'refused' ? outcome.reason : outcome.kind,
        });
        return { kind: 'blocked' };
      }
      if (!p.enabled()) {
        await p.store.writeRun(scope, { ...released, status: 'blocked', outcome: 'blocked_disabled' });
        return { kind: 'blocked_disabled' };
      }
      let status: PlannerRun['status'] = outcome ? 'rejected' : 'insufficient';
      let accepted: readonly Opportunity[] = [];
      if (outcome?.kind === 'proposed') {
        const fresh = await currentFacts(p, scope, context, outcome.output.opportunities);
        if (state.desiredRevision !== run.revision || fresh.revision !== context.contextRevision) status = 'stale';
        else if (outcome.output.opportunities.every((x) => !opportunityIssue(x, fresh.facts))) {
          accepted = diversify(outcome.output.opportunities);
          status = 'accepted';
        }
      }
      const closed = outcome
        ? await p.harness.closeRun(scope, { runId: run.id, state: status === 'accepted' ? 'completed' : 'cancelled' })
        : 'not_open';
      if (status === 'accepted' && closed !== 'closed') status = 'rejected';
      if (status === 'accepted' && outcome?.kind === 'proposed')
        await p.store.accept(scope, run, accepted, outcome.attemptId);
      await p.store.writeRun(scope, { ...released, status, outcome: outcome?.kind ?? 'insufficient_evidence' });
      const { activeRunId: _active, ...idle } = state;
      const next = { ...idle, acceptedRevision: status === 'accepted' ? run.revision : state.acceptedRevision };
      await p.store.writeState(scope, next);
      // A newer material revision gets one successor only after this result is conclusively settled.
      if (state.desiredRevision > run.revision) await ensureRun(p, scope, next);
      return { kind: status };
    });
  };
}
export function makeReadPlannerOpportunities(p: PlannerReadPorts): ReadPlannerOpportunities {
  return async (scope, query) => {
    if (
      !Number.isSafeInteger(query.limit) ||
      query.limit < 1 ||
      query.limit > 3 ||
      !z.iso.datetime().safeParse(query.evaluatedAt).success
    )
      throw new Error('PLANNER_READ_BOUNDS');
    const state = await p.store.state(scope),
      revision = (await p.store.revisions(scope, 1))[0];
    if (!revision) return { revision: 0, contextRevision: 0, opportunities: [], availability: 'absent' };
    // Revalidate references under the caller's existing scope; stale plans never become current facts.
    const rows = await p.store.run(scope, revision.runId);
    const c = rows?.context;
    if (!c || state.desiredRevision !== revision.revision)
      return {
        revision: revision.revision,
        contextRevision: revision.contextRevision,
        opportunities: [],
        availability: 'stale',
      };
    const fresh = await currentFacts(p, scope, c, revision.opportunities);
    if (fresh.revision !== revision.contextRevision)
      return {
        revision: revision.revision,
        contextRevision: revision.contextRevision,
        opportunities: [],
        availability: 'stale',
      };
    const opportunities = revision.opportunities
      .filter((x) => Date.parse(x.expiresAt) > Date.parse(query.evaluatedAt) && !opportunityIssue(x, fresh.facts))
      .slice(0, query.limit);
    return {
      revision: revision.revision,
      contextRevision: revision.contextRevision,
      opportunities,
      availability: 'available',
    };
  };
}
