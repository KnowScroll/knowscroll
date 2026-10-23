import {
  parsePersonalRecordingPurpose,
  type CheckPersonalRecordingRun,
  type PersonalRecordingPurpose,
  type ProposeOutcome,
  type ProposeRefusal,
} from '../../../reasoning/public.js';
import type { RecordingScopeTx } from '../../identity/public.js';
import type {
  CartographerPorts,
  GeographyContext,
  GeographyPorts,
  RunCartographer,
  PublishGeographyDelta,
  GeographyRun,
  GeographyAccountingHeader,
} from './ports.js';
import { reconcileWithRules, requiredChanges, type FormationPlan } from '../domain/formation.js';
import { GEOGRAPHY_POLICY, type GeographyProposal } from '../domain/policy.js';
import { CartographyJobSchema } from '../events.js';
import { prepareGeography } from './context.js';
import { cartographerRole, cartographyContextItems, geographyContextHashes } from './role.js';
import { ensureCartography } from './request.js';
import { applyProposal } from './apply.js';
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/** Actual owner: header/root/active claim before a separate cap-bound body read. */
export function makeCheckGeographyRecordingRun(
  p: Pick<GeographyPorts, 'store' | 'now' | 'hash'>,
): CheckPersonalRecordingRun {
  return async (cap, input) => {
    const root = await p.store.root(cap);
    const purpose = parsePersonalRecordingPurpose(input);
    if (
      !purpose ||
      purpose.ownerModule !== 'geography' ||
      purpose.purpose !== 'personal-cartographer' ||
      purpose.recordingGeneration !== cap.generation ||
      !same(purpose.universeId, cap.personal.authority.universeId) ||
      purpose.privacyEpoch !== cap.personal.authority.privacyEpoch
    )
      return 'unavailable';
    const state = await p.store.state(cap.personal),
      h = await p.store.header(cap.personal, purpose.businessRunId);
    if (
      !h ||
      !h.recording ||
      !same(root.accountId, purpose.accountId) ||
      !same(h.recording.accountId, purpose.accountId) ||
      h.recording.source.generation !== cap.generation ||
      state.activeRunId !== h.id ||
      h.status !== 'prepared' ||
      !h.claimId ||
      !same(h.claimId, purpose.claimId) ||
      !h.claimUntil ||
      Date.parse(h.claimUntil) <= p.now().getTime() ||
      !h.hasContext ||
      h.contextSha256 !== purpose.contextSha256 ||
      h.modelContextSha256 !== purpose.modelContextSha256
    )
      return 'unavailable';
    const c = await p.store.context(cap, h.id);
    if (
      !c ||
      c.version !== 'cartographer-context.v1' ||
      !same(c.universeId, purpose.universeId) ||
      c.privacyEpoch !== purpose.privacyEpoch ||
      c.desiredRevision !== h.desiredRevision ||
      new TextEncoder().encode(JSON.stringify(c)).length > 500000
    )
      return 'unavailable';
    try {
      const hashes = geographyContextHashes(c, h.id, p.hash);
      return hashes.contextSha256 === purpose.contextSha256 && hashes.modelContextSha256 === purpose.modelContextSha256
        ? 'current'
        : 'unavailable';
    } catch {
      return 'unavailable';
    }
  };
}
/** Necessary revocation cleanup only; exact accounting owns its UPDATE fence before header. */
async function retireRevoked(
  p: CartographerPorts,
  authority: Parameters<CartographerPorts['withScope']>[0],
  runId: string,
  delivered?: {
    readonly generation: number | null;
    readonly wakeId?: string;
    readonly legacyOrdinary?: boolean;
    readonly expectedClaimId?: string;
  },
) {
  await p.withScope(authority, async (scope) => {
    let h: GeographyAccountingHeader | undefined,
      revoked = false,
      legacyDelivery = false;
    const result = await p.harness.readPersonalRunAccounting(scope, runId, async (current, owner) => {
      h = await p.store.accountingHeader(current, runId);
      if (!h || !delivered) return 'unavailable';
      if (
        delivered.wakeId
          ? h.normalWakeId !== delivered.wakeId
          : delivered.expectedClaimId
            ? !!h.normalWakeId ||
              h.status !== 'prepared' ||
              h.claimId !== delivered.expectedClaimId ||
              h.claimWakeClaimId !== delivered.expectedClaimId
            : !!h.normalWakeId || !!h.claimId || !!h.claimWakeClaimId
      )
        return 'unavailable';
      legacyDelivery = !!(
        h &&
        delivered?.legacyOrdinary &&
        delivered.generation === 1 &&
        delivered.wakeId &&
        h.normalWakeId === delivered.wakeId &&
        h.legacyOrigin
      );
      if (
        !h ||
        ((!h.accountId || h.generation === undefined) && !h.legacyOrigin) ||
        (delivered && (h.generation ?? null) !== delivered.generation && !legacyDelivery) ||
        !['queued', 'prepared', 'blocked', 'unknown'].includes(h.status)
      )
        return 'unavailable';
      // A stale/forged wake never retires a genuinely current source.
      if ((await p.fenceRecording(current, h.generation)).kind === 'recording') return 'unavailable';
      if (
        !same(owner.universeId, current.authority.universeId) ||
        owner.privacyEpoch !== current.authority.privacyEpoch ||
        (h.accountId && !same(h.accountId, owner.accountId))
      )
        return 'unavailable';
      revoked = true;
      return {
        ownerModule: 'geography',
        purpose: 'personal-cartographer',
        accountId: h.accountId ?? owner.accountId,
        privacyEpoch: current.authority.privacyEpoch,
        recordingGeneration: h.generation ?? null,
      };
    });
    if (!h || !revoked) return;
    if (result.kind !== 'not_found' && (result.kind !== 'accounted' || result.disposition !== 'conclusive')) {
      if (delivered?.wakeId && ((h.generation ?? null) === delivered.generation || legacyDelivery))
        await p.store.consumeNormalWake(scope, h.id, delivered.wakeId);
      return;
    }
    const state = await p.store.state(scope);
    if (state.activeRunId !== h.id) return;
    await p.store.retire(scope, h.id);
    const idle = { ...state, activeRunId: undefined };
    await p.store.writeState(scope, idle);
    if (idle.desiredSource) {
      const gate = await p.fenceRecording(scope, idle.desiredSource.generation);
      if (gate.kind === 'recording') await ensureCartography(p, gate.scope, idle);
    }
  });
}
/** Refusals the harness makes before it admits a run, so no ledger run or attempt exists. */
const PRE_ADMISSION_REFUSALS: ReadonlySet<string> = new Set<ProposeRefusal>([
  'provider_unavailable',
  'role_invalid',
  'run_invalid',
  'run_mismatch',
  'context_invalid',
  'context_insufficient',
  'request_too_large',
]);
/**
 * Settles a run the harness refused before admitting it. Only actual zero-retained accounting may
 * settle the exact current claim here. There is no ledger run to apply under or close, so the rules
 * apply under the claim's own authority (same validation, revision check and transaction as any
 * apply); with nothing due the run is released. Either way the person's cartography is not held:
 * the next qualified encounter starts a new run.
 */
async function settleUnadmitted(
  p: CartographerPorts,
  authority: Parameters<CartographerPorts['withScope']>[0],
  purpose: PersonalRecordingPurpose,
  refusal: string,
) {
  await p.withScope(authority, async (scope) => {
    let eligible = false;
    const result = await p.harness.readPersonalRunAccounting(scope, purpose.businessRunId, async (current, owner) => {
      const h = await p.store.accountingHeader(current, purpose.businessRunId);
      if (
        !h ||
        h.status !== 'prepared' ||
        !h.accountId ||
        !same(h.accountId, owner.accountId) ||
        !same(owner.accountId, purpose.accountId) ||
        h.generation !== purpose.recordingGeneration ||
        h.claimId !== purpose.claimId ||
        h.claimWakeClaimId !== purpose.claimId ||
        h.normalWakeId ||
        !h.claimUntil ||
        Date.parse(h.claimUntil) <= p.now().getTime() ||
        (await p.store.state(current)).activeRunId !== h.id ||
        (await p.fenceRecording(current, purpose.recordingGeneration)).kind !== 'recording'
      )
        return 'unavailable';
      eligible = true;
      return {
        ownerModule: 'geography',
        purpose: 'personal-cartographer',
        accountId: owner.accountId,
        privacyEpoch: owner.privacyEpoch,
        recordingGeneration: h.generation,
      };
    });
    if (!eligible || result.kind !== 'not_found') return;
    const gate = await p.fenceRecording(scope, purpose.recordingGeneration);
    if (gate.kind !== 'recording') return;
    const context = await p.store.context(gate.scope, purpose.businessRunId);
    const rules = context && p.enabled() ? requiredChanges(context.facts) : undefined;
    let settlement: { status: 'accepted' | 'insufficient' | 'stale'; outcome: string } = {
      status: 'insufficient',
      outcome: refusal,
    };
    if (context && rules?.operations.length) {
      const applied = await applyProposal(p, gate.scope, purpose.businessRunId, context, rules, () =>
        Promise.resolve(),
      );
      settlement =
        applied.kind === 'refused'
          ? { status: applied.reason === 'no_changes' ? 'insufficient' : 'stale', outcome: applied.reason }
          : { status: 'accepted', outcome: OUTCOME_OF_SOURCE.rules };
    }
    await p.store.finishUnadmitted(scope, purpose.businessRunId, purpose.claimId, settlement);
    const updated = await p.store.state(scope),
      idle = { ...updated, activeRunId: undefined };
    await p.store.writeState(scope, idle);
    if (context && updated.desiredRevision > context.desiredRevision) await ensureCartography(p, gate.scope, idle);
  });
}
/** What the harness returned for one Cartographer run, with the frozen run it belongs to. */
interface ModelAnswer {
  readonly run: GeographyRun;
  readonly context: GeographyContext;
  readonly purpose: PersonalRecordingPurpose;
  readonly outcome: ProposeOutcome<GeographyProposal>;
}
/**
 * What to apply for a model answer, decided by code.
 *
 * A valid proposal is reconciled with the rules: every required change it left out is added, or
 * the rules alone are applied when the two conflict. When the model gave nothing usable (invalid
 * output, provider failure, quota or budget), the rules alone are applied with canonical labels.
 * `unknown` never falls back: that attempt may still be reconciled, so the run stays unknown until
 * an operator resumes it. An unusable answer with nothing due settles the run; the next qualified
 * encounter starts a new one.
 */
function planFor(
  outcome: ProposeOutcome<GeographyProposal>,
  facts: GeographyContext['facts'],
): FormationPlan | undefined {
  if (outcome.kind === 'proposed') return reconcileWithRules(outcome.output, facts);
  if (outcome.kind === 'unknown') return undefined;
  const proposal = requiredChanges(facts);
  return proposal.operations.length ? { proposal, source: 'rules' } : undefined;
}
const OUTCOME_OF_SOURCE = {
  model: 'applied',
  model_with_rules: 'applied_with_rules',
  rules: 'applied_by_rules',
} as const;
/** Short apply transaction: recheck the claim, apply or record why not, close the ledger run. */
async function settleRun(p: CartographerPorts, cap: RecordingScopeTx, answer: ModelAnswer): Promise<void> {
  const { run, context, purpose, outcome } = answer;
  const scope = cap.personal,
    state = await p.store.state(scope),
    current = await p.store.header(scope, run.id);
  if (!current || state.activeRunId !== run.id || current.claimId !== run.claimId || current.status !== 'prepared')
    return;
  const { claimId: _claim, claimUntil: _until, claimWakeClaimId: _wake, normalWakeId: _normal, ...released } = current;
  const plan = planFor(outcome, context.facts);
  if (outcome.kind === 'unknown') {
    await p.store.writeRun(scope, { ...released, status: 'unknown', outcome: 'unknown' });
    return;
  }
  let status: GeographyRun['status'] = 'rejected',
    reason: string = outcome.kind === 'refused' ? outcome.reason : outcome.kind,
    closed = false;
  // A refusal can come from a run the ledger has already closed; then nothing is left to close.
  const closeLedger = async (state: 'completed' | 'cancelled') => {
    const result = await p.harness.closePersonalRun(cap, { runId: run.id, state, recordingPurpose: purpose });
    if (result !== 'closed' && !(result === 'not_open' && outcome.kind === 'refused'))
      throw new Error('GEOGRAPHY_HARNESS_NOT_CLOSED');
    closed = true;
  };
  const close = () => closeLedger('completed');
  if (!p.enabled()) {
    status = 'stale';
    reason = 'disabled';
  } else if (state.desiredRevision !== context.desiredRevision) {
    status = 'stale';
    reason = 'desired_revision_changed';
  } else if (plan) {
    const result = await applyProposal(p, cap, run.id, context, plan.proposal, close);
    if (result.kind === 'refused') {
      status = result.reason === 'no_changes' ? 'insufficient' : 'stale';
      reason = result.reason;
    } else {
      if (result.kind === 'replayed') await close();
      status = 'accepted';
      reason = OUTCOME_OF_SOURCE[plan.source];
    }
  }
  if (!closed) await closeLedger('cancelled');
  await p.store.writeRun(scope, {
    ...released,
    status,
    outcome: reason,
    ...(plan ? { proposal: plan.proposal } : {}),
    ...(outcome.kind === 'proposed' ? { attemptId: outcome.attemptId } : {}),
  });
  const updated = await p.store.state(scope),
    idle = { ...updated, activeRunId: undefined };
  await p.store.writeState(scope, idle);
  if (updated.desiredRevision > run.desiredRevision && updated.desiredSource?.generation === cap.generation)
    await ensureCartography(p, cap, idle);
}
/** Short prepare/apply transactions around the shared finite attempt ledger. */
export function makeRunCartographer(p: CartographerPorts): RunCartographer {
  return async (input, signal) => {
    const job = CartographyJobSchema.parse(input),
      authority = {
        universeId: job.universeId,
        privacyEpoch: job.privacyEpoch,
        actor: { kind: 'system' as const, purpose: 'geography.cartograph' },
      };
    if (job.kind === 'retire') {
      await retireRevoked(p, authority, job.runId, { generation: job.recordingGeneration ?? null, wakeId: job.wakeId });
      return;
    }
    const prepared = await p.withScope(authority, async (scope) => {
      if ((await p.fenceOwn(scope)).kind !== 'active') return undefined;
      const gate = await p.fenceRecording(scope, job.v === 2 ? (job.recordingGeneration ?? undefined) : undefined);
      if (gate.kind !== 'recording') return { kind: 'revoked' } as const;
      const cap = gate.scope,
        root = await p.store.root(cap),
        state = await p.store.state(scope),
        run = await p.store.header(scope, job.runId);
      if (!run || state.activeRunId !== run.id || !['queued', 'prepared'].includes(run.status)) return undefined;
      if (
        run.recording
          ? run.recording.source.generation !== cap.generation || !same(run.recording.accountId, root.accountId)
          : cap.generation !== 1
      )
        return { kind: 'revoked' } as const;
      if (Boolean(run.claimId) !== Boolean(run.claimUntil)) return undefined;
      if (job.v === 1) {
        if (run.recording || run.normalWakeId) return undefined;
      } else if (
        job.wakeId
          ? run.normalWakeId !== job.wakeId
          : !!run.normalWakeId ||
            !job.expectedClaimId ||
            run.claimId !== job.expectedClaimId ||
            run.claimWakeClaimId !== job.expectedClaimId ||
            run.status !== 'prepared'
      )
        return undefined;
      if (job.expectedClaimId && (run.claimId !== job.expectedClaimId || run.status !== 'prepared')) return undefined;
      if (run.claimUntil && Date.parse(run.claimUntil) > p.now().getTime()) {
        if (job.expectedClaimId) throw new Error('GEOGRAPHY_CLAIM_WAKE_EARLY');
        return undefined;
      }
      if (run.recording && run.hasContext && (!run.contextSha256 || !run.modelContextSha256)) return undefined;
      const { normalWakeId: _normal, claimWakeClaimId: _wake, claimId: _claim, claimUntil: _until, ...consumed } = run;
      if (!p.enabled()) {
        // Released, not parked: reading while the role is off must not strand the person's cartography.
        await p.store.writeRun(scope, { ...consumed, status: 'insufficient', outcome: 'disabled' });
        await p.store.writeState(scope, { ...state, activeRunId: undefined });
        return undefined;
      }
      const context = run.hasContext
        ? await p.store.context(cap, run.id)
        : await prepareGeography(p, cap, await p.store.view(scope));
      if (
        !context ||
        context.version !== 'cartographer-context.v1' ||
        !same(context.universeId, authority.universeId) ||
        context.privacyEpoch !== authority.privacyEpoch ||
        (run.hasContext && context.desiredRevision !== run.desiredRevision)
      ) {
        await p.store.writeRun(scope, { ...consumed, status: 'insufficient', outcome: 'coverage_unavailable' });
        await p.store.writeState(scope, { ...state, activeRunId: undefined });
        return undefined;
      }
      let hashes: ReturnType<typeof geographyContextHashes>;
      try {
        hashes = geographyContextHashes(context, run.id, p.hash);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'GEOGRAPHY_CONTEXT_LIMIT') throw error;
        await p.store.writeRun(scope, { ...consumed, status: 'insufficient', outcome: 'context_limit' });
        await p.store.writeState(scope, { ...state, activeRunId: undefined });
        return undefined;
      }
      if (
        run.recording &&
        run.hasContext &&
        (hashes.contextSha256 !== run.contextSha256 || hashes.modelContextSha256 !== run.modelContextSha256)
      )
        return undefined;
      if (!(await p.ownerActive(scope))) return undefined;
      const claimed: GeographyRun = {
        ...consumed,
        recording: run.recording ?? { accountId: root.accountId, source: { generation: 1, kind: 'legacy1' } },
        ...hashes,
        desiredRevision: context.desiredRevision,
        status: 'prepared',
        context,
        claimId: p.newId(),
        claimUntil: new Date(p.now().getTime() + 1150000).toISOString(),
      };
      await p.store.writeRun(scope, claimed);
      // Every new claim, including delayed renewal, has its own durable recovery in this TX.
      if (
        !(await p.enqueue(cap, run.id, {
          expectedClaimId: claimed.claimId!,
          startAfter: new Date(Date.parse(claimed.claimUntil!) + 1000),
        }))
      )
        throw new Error('GEOGRAPHY_REQUIRED_CLAIM_WAKE');
      return { kind: 'prepared', run: claimed, context } as const;
    });
    if (prepared.kind !== 'entered' || !prepared.value) return;
    if (prepared.value.kind === 'revoked') {
      await retireRevoked(p, authority, job.runId, {
        generation: job.v === 2 ? (job.recordingGeneration ?? null) : null,
        wakeId: job.wakeId,
        expectedClaimId: job.expectedClaimId,
        legacyOrdinary: job.v === 2 && job.recordingGeneration === 1 && !!job.wakeId,
      });
      return;
    }
    const { run, context: c } = prepared.value;
    const purpose: PersonalRecordingPurpose = {
      version: 'personal-role-purpose.v1',
      accountId: run.recording!.accountId,
      universeId: authority.universeId,
      privacyEpoch: authority.privacyEpoch,
      ownerModule: 'geography',
      purpose: 'personal-cartographer',
      businessRunId: run.id,
      recordingGeneration: run.recording!.source.generation,
      contextSha256: run.contextSha256!,
      modelContextSha256: run.modelContextSha256!,
      claimId: run.claimId!,
    };
    const outcome = await p.harness.proposePersonal(
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
        recordingPurpose: purpose,
      },
      signal,
    );
    if (outcome.kind === 'refused' && PRE_ADMISSION_REFUSALS.has(outcome.reason)) {
      await settleUnadmitted(p, authority, purpose, outcome.reason);
      return;
    }
    const applied = await p.harness.withPersonalApply(authority, purpose, (cap) =>
      settleRun(p, cap, { run, context: c, purpose, outcome }),
    );
    if (applied.kind === 'refused')
      await retireRevoked(p, authority, run.id, {
        generation: run.recording!.source.generation,
        expectedClaimId: run.claimId,
      });
  };
}
/** Already committed delta display stays available while recording is paused. */
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
