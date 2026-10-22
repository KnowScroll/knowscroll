import { z } from 'zod';
import {
  diversify,
  opportunityIssue,
  PLANNER_POLICY,
  type Opportunity,
  type ValidationFacts,
} from '../domain/proposal.js';
import {
  parsePersonalRecordingPurpose,
  type CheckPersonalRecordingRun,
  type PersonalRecordingPurpose,
} from '../../../reasoning/public.js';
import type { PersonalScopeTx } from '../../identity/public.js';
import type {
  FrozenContext,
  PlannerPorts,
  PlannerReadPorts,
  PlannerRun,
  PlannerAccountingHeader,
  ReadPlannerOpportunities,
  RunPlanner,
} from './ports.js';
import { prepareContext } from './context.js';
import { ensureRun } from './request.js';
import { PlannerJobSchema } from '../events.js';
import { plannerContextItems, plannerContextHashes, plannerRole } from './role.js';

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
  if (snapshot.proofAvailability !== 'available') return undefined;
  const inventory: ValidationFacts['inventory'][number][] = [];
  for (const x of opportunities) {
    const target =
      x.target.kind === 'existing'
        ? x.target
        : c.facts.inventory.find((a) => a.explanationUnitId === x.explanationUnitId);
    if (!target) continue;
    const a = await p.readExact(scope, {
      assetId: target.assetId,
      assetRevision: target.assetRevision,
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
/** Necessary accounting is a separate fresh root: its public adapter acquires the one own gate.
 * It never exposes protected answers and cannot turn an unknown into resend permission. */
async function retireRevoked(
  p: PlannerPorts,
  authority: Parameters<PlannerPorts['withPersonalScope']>[0],
  payload: Parameters<RunPlanner>[0],
) {
  return p.withPersonalScope(authority, async (scope) => {
    const original = payload.v === 1 ? 1 : payload.recordingGeneration!;
    const observed: { header: PlannerAccountingHeader | undefined; mismatch: boolean; missing: boolean } = {
      header: undefined,
      mismatch: false,
      missing: false,
    };
    const accounting = await p.harness.readPersonalRunAccounting(scope, payload.runId, async (gated) => {
      const header = await p.store.accountingHeader(gated, payload.runId);
      observed.header = header;
      if (!header) {
        observed.missing = true;
        return 'unavailable';
      }
      if (header.generation !== undefined ? header.generation !== original : payload.v !== 1) {
        observed.mismatch = true;
        return 'unavailable';
      }
      const accountId = await p.store.account(gated);
      if (
        !accountId ||
        (header.generation !== undefined && !header.accountId) ||
        (header.accountId && header.accountId !== accountId)
      )
        return 'unavailable';
      return {
        ownerModule: 'planner',
        purpose: 'personal-planner',
        accountId,
        privacyEpoch: gated.authority.privacyEpoch,
        recordingGeneration: header.generation ?? null,
      };
    });
    if (observed.missing) return { kind: 'not_active' } as const;
    if (observed.mismatch) return { kind: 'generation_mismatch' } as const;
    if (accounting.kind === 'unavailable') return { kind: 'accounting_unavailable' } as const;
    const header = observed.header;
    const state = await p.store.stateHeader(scope);
    if (!header || state.activeRunId !== header.id) return { kind: 'not_active' } as const;
    const gate = await p.fenceRecording(scope, original);
    if (gate.kind === 'recording') return undefined;
    if (header.generation === undefined) return { kind: 'revoked_accounting_unproved' } as const;
    if (accounting.kind === 'accounted' && accounting.disposition === 'unresolved')
      return { kind: 'revoked_accounting_unresolved' } as const;
    if (!(await p.store.retire(scope, header.id))) return { kind: 'not_active' } as const;
    const { activeRunId: _a, ...idle } = state;
    await p.store.writeState(scope, idle);
    // A toggle creates no desired source. Only a separately retained eligible trigger can wake.
    if (state.desiredSource) {
      const current = await p.fenceRecording(scope, state.desiredSource.generation);
      if (current.kind === 'recording' && state.desiredSource.generation !== original)
        await ensureRun(p, current.scope, await p.store.state(scope));
    }
    return { kind: 'recording_ineligible' } as const;
  });
}
export function makeRunPlanner(p: PlannerPorts): RunPlanner {
  return async (raw, signal) => {
    const payload = PlannerJobSchema.parse(raw),
      original = payload.v === 1 ? 1 : payload.recordingGeneration!;
    const authority = {
      universeId: payload.universeId,
      privacyEpoch: payload.privacyEpoch,
      actor: { kind: 'system', purpose: 'planner.run' },
    } as const;
    const retired = await retireRevoked(p, authority, payload);
    if (retired.kind !== 'entered') return retired;
    if (retired.value !== undefined) return { kind: 'entered', value: retired.value };
    const preparation = await p.withPersonalScope(authority, async (scope) => {
      const owner = await p.fenceOwn(scope);
      if (owner.kind !== 'active') return { kind: 'universe_unavailable' } as const;
      const gate = await p.fenceRecording(scope, original);
      if (gate.kind !== 'recording') return { kind: 'recording_ineligible' } as const;
      const cap = gate.scope,
        header = await p.store.header(scope, payload.runId);
      if (!header) return { kind: 'not_active' } as const;
      if (
        (header.recording?.source.generation ?? 1) !== original ||
        (header.recording && header.recording.accountId !== owner.owner.accountId)
      )
        return { kind: 'generation_mismatch' } as const;
      if (header.recording && header.hasContext && (!header.contextSha256 || !header.modelContextSha256))
        return { kind: 'recording_proof_unavailable' } as const;
      if (
        payload.v === 1 &&
        header.recording &&
        (header.recording.source.kind !== 'legacy1' ||
          header.claimId !== undefined ||
          header.claimWakeClaimId !== undefined)
      )
        return { kind: 'obsolete_wake' } as const;
      if (payload.expectedClaimId) {
        if (
          header.claimId !== payload.expectedClaimId ||
          header.status !== 'prepared' ||
          header.claimWakeClaimId !== payload.expectedClaimId
        )
          return { kind: 'obsolete_claim_wake' } as const;
      } else if (payload.v === 2 ? header.normalWakeId !== payload.wakeId : header.normalWakeId !== undefined)
        return { kind: 'obsolete_wake' } as const;
      const stateHeader = await p.store.stateHeader(scope);
      if (stateHeader.activeRunId !== header.id) return { kind: 'not_active' } as const;
      if (header.claimUntil && Date.parse(header.claimUntil) > p.now().getTime()) {
        if (payload.expectedClaimId) throw new Error('PLANNER_CLAIM_WAKE_EARLY');
        return { kind: 'already_running' } as const;
      }
      if (header.status === 'blocked' || header.status === 'unknown')
        return { kind: 'awaiting_explicit_resume' } as const;
      const recording = header.recording ?? {
        accountId: owner.owner.accountId,
        source: { generation: 1, kind: 'legacy1' as const },
      };
      if (!p.enabled()) {
        const { normalWakeId: _n, claimWakeClaimId: _w, claimId: _c, claimUntil: _u, ...released } = header;
        await p.store.writeRun(scope, { ...released, status: 'blocked', outcome: 'blocked_disabled' });
        return { kind: 'blocked_disabled' } as const;
      }
      // The header gates above precede frozen bytes, intent, PC/catalogue reads and claim mutation.
      const state = await p.store.state(scope);
      if (state.desiredSource && state.desiredSource.generation !== original)
        return { kind: 'generation_mismatch' } as const;
      let context = header.hasContext ? await p.store.context(scope, header.id) : undefined;
      if (context && context.snapshot.proofAvailability !== 'available') {
        const { normalWakeId: _n, claimWakeClaimId: _w, claimId: _c, claimUntil: _u, ...released } = header;
        await p.store.writeRun(scope, { ...released, status: 'blocked', outcome: 'proof_unavailable' });
        return { kind: 'proof_unavailable' } as const;
      }
      try {
        context ??= await prepareContext(p, scope, state);
        const hashes = plannerContextHashes(context, header.id, p.canonicalHash);
        if (
          header.hasContext &&
          ((header.contextSha256 && header.contextSha256 !== hashes.contextSha256) ||
            (header.modelContextSha256 && header.modelContextSha256 !== hashes.modelContextSha256))
        )
          throw new Error('PLANNER_FROZEN_CONTEXT_MISMATCH');
        const { claimWakeClaimId: _wake, normalWakeId: _normal, ...rest } = header;
        const run = {
          ...rest,
          recording,
          revision: header.hasContext ? header.revision : state.desiredRevision,
          status: 'prepared' as const,
          context,
          contextSha256: hashes.contextSha256,
          modelContextSha256: hashes.modelContextSha256,
          claimId: p.newId(),
          claimUntil: new Date(p.now().getTime() + 1150000).toISOString(),
        };
        await p.store.writeRun(scope, run);
        await p.enqueue(cap, run.id, {
          expectedClaimId: run.claimId,
          startAfter: new Date(Date.parse(run.claimUntil) + 1000),
        });
        return { kind: 'prepared', run } as const;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !['PLANNER_CONTEXT_TOO_LARGE', 'PLANNER_PROOF_UNAVAILABLE'].includes(error.message)
        )
          throw error;
        const { normalWakeId: _n, claimWakeClaimId: _w, claimId: _c, claimUntil: _u, ...released } = header;
        const unavailable = error.message === 'PLANNER_PROOF_UNAVAILABLE';
        await p.store.writeRun(scope, {
          ...released,
          status: unavailable ? 'blocked' : 'insufficient',
          outcome: unavailable ? 'proof_unavailable' : 'context_bounds',
        });
        if (!unavailable) {
          const { activeRunId: _active, ...idle } = state;
          await p.store.writeState(scope, idle);
        }
        return { kind: unavailable ? 'proof_unavailable' : 'context_bounds' } as const;
      }
    });
    if (preparation.kind !== 'entered' || preparation.value.kind !== 'prepared') return preparation;
    const run = preparation.value.run,
      context = run.context;
    const purpose: PersonalRecordingPurpose = {
      version: 'personal-role-purpose.v1',
      accountId: run.recording.accountId,
      universeId: authority.universeId,
      privacyEpoch: authority.privacyEpoch,
      ownerModule: 'planner',
      purpose: 'personal-planner',
      businessRunId: run.id,
      recordingGeneration: original,
      contextSha256: run.contextSha256,
      modelContextSha256: run.modelContextSha256,
      claimId: run.claimId,
    };
    const outcome =
      context.facts.evidence.length === 0
        ? undefined
        : await p.harness.proposePersonal(
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
              recordingPurpose: purpose,
            },
            signal,
          );
    // Sole facade entry owns root/account/originalg and actual owner/ledger header proof. No nested
    // root and no repeated Identity account gate. Close while owner is still prepared/claimed.
    return p.harness.withPersonalApply(authority, purpose, async (cap) => {
      const scope = cap.personal,
        state = await p.store.state(scope),
        current = await p.store.header(scope, run.id);
      if (!current || state.activeRunId !== run.id || current.claimId !== run.claimId || current.status !== 'prepared')
        throw new Error('PLANNER_APPLY_OWNER_CHANGED');
      const {
        claimId: _claim,
        claimUntil: _until,
        claimWakeClaimId: _wake,
        normalWakeId: _normal,
        ...released
      } = current;
      if (outcome?.kind === 'unknown' || outcome?.kind === 'quota_unavailable') {
        await p.store.writeRun(scope, {
          ...released,
          status: outcome.kind === 'unknown' ? 'unknown' : 'blocked',
          outcome: outcome.kind,
        });
        return { kind: outcome.kind };
      }
      if (outcome?.kind === 'budget_exhausted' || outcome?.kind === 'refused') {
        await p.store.writeRun(scope, {
          ...released,
          status: current.outcome === 'unknown' ? 'unknown' : 'blocked',
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
        if (!fresh) {
          await p.store.writeRun(scope, { ...released, status: 'blocked', outcome: 'proof_unavailable' });
          return { kind: 'proof_unavailable' };
        }
        if (state.desiredRevision !== run.revision || fresh.revision !== context.contextRevision) status = 'stale';
        else if (outcome.output.opportunities.every((x) => !opportunityIssue(x, fresh.facts))) {
          accepted = diversify(outcome.output.opportunities);
          status = 'accepted';
        }
      }
      const closed = outcome
        ? await p.harness.closePersonalRun(cap, {
            runId: run.id,
            state: status === 'accepted' ? 'completed' : 'cancelled',
            recordingPurpose: purpose,
          })
        : 'not_open';
      if (status === 'accepted' && closed !== 'closed') throw new Error('PLANNER_REASONING_CLOSE_FAILED');
      if (status === 'accepted' && outcome?.kind === 'proposed')
        await p.store.accept(scope, run, accepted, outcome.attemptId);
      await p.store.writeRun(scope, { ...released, status, outcome: outcome?.kind ?? 'insufficient_evidence' });
      const { activeRunId: _a, ...idle } = state,
        next = { ...idle, acceptedRevision: status === 'accepted' ? run.revision : state.acceptedRevision };
      await p.store.writeState(scope, next);
      if (state.desiredRevision > run.revision && state.desiredSource?.generation === cap.generation)
        await ensureRun(p, cap, next);
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
    const c = await p.store.context(scope, revision.runId);
    if (!c || state.desiredRevision !== revision.revision)
      return {
        revision: revision.revision,
        contextRevision: revision.contextRevision,
        opportunities: [],
        availability: 'stale',
      };
    const fresh = await currentFacts(p, scope, c, revision.opportunities);
    if (!fresh || fresh.revision !== revision.contextRevision)
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

/** The Reasoning facade already holds its own gate; this owner checks actual PK metadata first. */
export function makeCheckPlannerRecordingRun(
  p: Pick<PlannerPorts, 'store' | 'now' | 'canonicalHash'>,
): CheckPersonalRecordingRun {
  return async (cap, value) => {
    const root = await p.store.root(cap);
    const purpose = parsePersonalRecordingPurpose(value);
    if (!purpose) return 'unavailable';
    if (
      purpose.version !== 'personal-role-purpose.v1' ||
      purpose.ownerModule !== 'planner' ||
      purpose.purpose !== 'personal-planner' ||
      purpose.universeId !== cap.personal.authority.universeId ||
      purpose.privacyEpoch !== cap.personal.authority.privacyEpoch ||
      purpose.recordingGeneration !== cap.generation
    )
      return 'unavailable';
    const header = await p.store.header(cap.personal, purpose.businessRunId);
    if (
      !header ||
      header.status !== 'prepared' ||
      !header.hasContext ||
      header.recording?.accountId !== root.accountId ||
      root.accountId !== purpose.accountId ||
      header.recording.source.generation !== cap.generation ||
      header.claimId !== purpose.claimId ||
      !header.claimUntil ||
      Date.parse(header.claimUntil) <= p.now().getTime() ||
      header.contextSha256 !== purpose.contextSha256 ||
      header.modelContextSha256 !== purpose.modelContextSha256
    )
      return 'unavailable';
    if ((await p.store.stateHeader(cap.personal)).activeRunId !== header.id) return 'unavailable';
    const context = await p.store.context(cap.personal, header.id);
    if (!context || context.snapshot.proofAvailability !== 'available') return 'unavailable';
    try {
      const hashes = plannerContextHashes(context, header.id, p.canonicalHash);
      return hashes.contextSha256 === header.contextSha256 && hashes.modelContextSha256 === header.modelContextSha256
        ? 'current'
        : 'unavailable';
    } catch {
      return 'unavailable';
    }
  };
}
