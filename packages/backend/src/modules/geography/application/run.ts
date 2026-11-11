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
  GeographyState,
} from './ports.js';
import { placesDue, reconcileWithRules, requiredChanges, type FormationPlan } from '../domain/formation.js';
import { nextRunNotBefore } from '../domain/pacing.js';
import { GEOGRAPHY_POLICY, type GeographyProposal } from '../domain/policy.js';
import { CartographyJobSchema } from '../events.js';
import { prepareGeography } from './context.js';
import { cartographerRole, geographyContextHashes, modelContextItems } from './role.js';
import { continueCartography, ensureCartography } from './request.js';
import { applyProposal, commitEvaluation } from './apply.js';
import { evaluationOf, nothingTrusted } from './context.js';
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/** The state once a run is done: nobody holds it, and the person's next run waits its interval. */
const idleAfterRun = (p: Pick<GeographyPorts, 'now'>, state: GeographyState): GeographyState => ({
  ...state,
  activeRunId: undefined,
  nextRunNotBefore: nextRunNotBefore(p.now()),
});
/**
 * Called by the recording-aware reasoning harness before it reads private context or applies a
 * reply. The supplied recording scope must match this account, generation, active run and live
 * claim; both frozen-context hashes must still agree. Any missing or expired binding refuses
 * authority, so a late model answer cannot act for a replaced run.
 */
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
 * Settles the exact current claim of a run that has no open ledger run to apply under or close:
 * the harness refused it before admitting it, a reading-triggered run with no place due that never
 * went to the harness (`no_changes`), a context too large for one model request (`context_limit`),
 * or a run whose ledger run was closed under it (`run_closed`).
 * Only actual accounting with no live attempt may settle it (zero retained attempts, or for
 * `run_closed` settled ones). The rules apply under the claim's own authority (same validation,
 * revision check and transaction as any apply); with nothing due the run is released with `reason`
 * as its outcome. Either way the person's cartography is not held: the next qualified encounter
 * starts a new run.
 */
async function settleUnadmitted(
  p: CartographerPorts,
  authority: Parameters<CartographerPorts['withScope']>[0],
  purpose: PersonalRecordingPurpose,
  reason: string,
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
    // A closed ledger run may hold settled attempts; any other end needs none retained.
    const nothingLive =
      result.kind === 'not_found' ||
      (reason === 'run_closed' && result.kind === 'accounted' && result.disposition === 'conclusive');
    if (!eligible || !nothingLive) return;
    const gate = await p.fenceRecording(scope, purpose.recordingGeneration);
    if (gate.kind !== 'recording') return;
    const context = await p.store.context(gate.scope, purpose.businessRunId);
    const rules = context && p.enabled() ? requiredChanges(context.facts) : undefined;
    let settlement: { status: 'accepted' | 'insufficient' | 'stale'; outcome: string } = {
      status: 'insufficient',
      outcome: reason,
    };
    let more = false;
    if (context && rules?.operations.length) {
      const applied = await applyProposal(p, gate.scope, purpose.businessRunId, context, rules, () =>
        Promise.resolve(),
      );
      more = applied.more ?? false;
      settlement =
        applied.kind === 'refused'
          ? { status: applied.reason === 'no_changes' ? 'insufficient' : 'stale', outcome: applied.reason }
          : {
              status: 'accepted',
              outcome: reason === 'context_limit' ? MODEL_SKIPPED_FOR_SIZE : OUTCOME_OF_SOURCE.rules,
            };
    } else if (context && rules) {
      // Nothing is due: the topics were evaluated, so record what it found and clear what it saw.
      more = (await commitEvaluation(p, scope, context.facts, evaluationOf(context), { clearDirty: true })).more;
    }
    await p.store.finishUnadmitted(scope, purpose.businessRunId, purpose.claimId, settlement);
    const updated = await p.store.state(scope),
      idle = idleAfterRun(p, updated);
    await p.store.writeState(scope, idle);
    if (context && updated.desiredRevision > context.desiredRevision)
      await ensureCartography(p, gate.scope, idle, true);
    else if (more) await continueCartography(p, gate.scope, idle);
  });
}
/**
 * Ends a prepared run whose frozen context this code can no longer hash the way it was hashed when
 * the run was claimed (the context layout changed in a deploy). The request it would send differs
 * from anything the ledger recorded, so it can never go on, and left alone it would hold the
 * person's scope for ever. When accounting shows no live attempt the run is retired
 * (`stale/context_changed`) and a successor takes the reading that is waiting. Nothing was spent
 * since the claim, so the successor is not paced. A run with an attempt in flight is left to the
 * ledger's own recovery.
 */
async function retireUnreadableContext(
  p: CartographerPorts,
  authority: Parameters<CartographerPorts['withScope']>[0],
  runId: string,
) {
  await p.withScope(authority, async (scope) => {
    let generation: number | undefined;
    const result = await p.harness.readPersonalRunAccounting(scope, runId, async (current, owner) => {
      const h = await p.store.accountingHeader(current, runId);
      if (
        !h ||
        !['queued', 'prepared'].includes(h.status) ||
        !h.accountId ||
        !same(h.accountId, owner.accountId) ||
        h.generation === undefined ||
        (h.claimUntil && Date.parse(h.claimUntil) > p.now().getTime()) ||
        (await p.store.state(current)).activeRunId !== h.id ||
        (await p.fenceRecording(current, h.generation)).kind !== 'recording'
      )
        return 'unavailable';
      generation = h.generation;
      return {
        ownerModule: 'geography',
        purpose: 'personal-cartographer',
        accountId: owner.accountId,
        privacyEpoch: owner.privacyEpoch,
        recordingGeneration: h.generation,
      };
    });
    const nothingLive =
      result.kind === 'not_found' || (result.kind === 'accounted' && result.disposition === 'conclusive');
    if (generation === undefined || !nothingLive) return;
    const gate = await p.fenceRecording(scope, generation);
    if (gate.kind !== 'recording') return;
    await p.store.retire(scope, runId, 'context_changed');
    const state = await p.store.state(scope),
      idle = { ...state, activeRunId: undefined };
    await p.store.writeState(scope, idle);
    if (idle.desiredSource?.generation === gate.scope.generation) await ensureCartography(p, gate.scope, idle);
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
  if (outcome.kind === 'proposed') {
    const plan = reconcileWithRules(outcome.output, facts);
    // An empty answer is the normal reply (D-052): the model adds nothing and code applies what is due.
    // That is a valid proposal plus the rules, not the rules alone for lack of a usable answer.
    return plan.source === 'rules' && outcome.output.operations.length === 0
      ? { ...plan, source: 'model_with_rules' }
      : plan;
  }
  if (outcome.kind === 'unknown') return undefined;
  const proposal = requiredChanges(facts);
  return proposal.operations.length ? { proposal, source: 'rules' } : undefined;
}
/**
 * The outcome of a run whose rules applied places because the context did not fit one model request, so
 * no model was asked. An operator tells it from an ordinary rules-only run (`applied_by_rules`) and from
 * `context_limit`, which is the same cause with nothing due.
 */
const MODEL_SKIPPED_FOR_SIZE = 'applied_by_rules_context_limit';
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
    closed = false,
    more = false;
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
  } else if (plan) {
    const result = await applyProposal(p, cap, run.id, context, plan.proposal, close);
    more = result.more ?? false;
    if (result.kind === 'refused') {
      status = result.reason === 'no_changes' ? 'insufficient' : 'stale';
      reason = result.reason;
    } else {
      if (result.kind === 'replayed') await close();
      status = 'accepted';
      reason = OUTCOME_OF_SOURCE[plan.source];
    }
  } else {
    // An unusable answer with nothing due: the evaluation is complete, so its topics are recorded and cleared.
    more = (await commitEvaluation(p, scope, context.facts, evaluationOf(context), { clearDirty: true })).more;
  }
  // A valid answer that concluded nothing needs changing was used, so it is completed, not cancelled.
  if (!closed) await closeLedger(outcome.kind === 'proposed' && reason === 'no_changes' ? 'completed' : 'cancelled');
  await p.store.writeRun(scope, {
    ...released,
    status,
    outcome: reason,
    ...(plan ? { proposal: plan.proposal } : {}),
    ...(outcome.kind === 'proposed' ? { attemptId: outcome.attemptId } : {}),
  });
  const updated = await p.store.state(scope),
    idle = idleAfterRun(p, updated);
  await p.store.writeState(scope, idle);
  if (updated.desiredRevision > run.desiredRevision && updated.desiredSource?.generation === cap.generation)
    await ensureCartography(p, cap, idle, true);
  else if (more) await continueCartography(p, cap, idle);
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
      let context: GeographyContext | undefined;
      if (run.hasContext) context = await p.store.context(cap, run.id);
      else {
        const prepared = await prepareGeography(p, cap, { kind: 'dirty' });
        if (prepared.kind === 'unavailable') {
          // Each cause is its own outcome. A reader with no coverage yet is healthy and builds no context.
          await p.store.writeRun(scope, { ...consumed, status: 'insufficient', outcome: prepared.reason });
          await p.store.writeState(scope, idleAfterRun(p, state));
          return undefined;
        }
        context = prepared.context;
      }
      if (
        !context ||
        context.version !== 'cartographer-context.v1' ||
        !same(context.universeId, authority.universeId) ||
        context.privacyEpoch !== authority.privacyEpoch ||
        (run.hasContext && context.desiredRevision !== run.desiredRevision)
      ) {
        await p.store.writeRun(scope, { ...consumed, status: 'insufficient', outcome: 'context_unreadable' });
        await p.store.writeState(scope, idleAfterRun(p, state));
        return undefined;
      }
      // The hashes do not depend on whether a model request would fit: only a model call needs that.
      const hashes = geographyContextHashes(context, run.id, p.hash);
      if (
        run.recording &&
        run.hasContext &&
        (hashes.contextSha256 !== run.contextSha256 || hashes.modelContextSha256 !== run.modelContextSha256)
      )
        return { kind: 'context_unreadable' } as const;
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
      // Only a run's first claim can skip the model: a later claim may already have an attempt in the
      // ledger. An explicit request wants the model's say even when nothing is due.
      const explicit = state.desiredSource?.kind === 'command' || claimed.recording?.source.kind === 'command';
      // With nothing trusted there is nothing for a model to choose, even for an explicit request.
      const modelOptional = !run.hasContext && (!explicit || nothingTrusted(context));
      return { kind: 'prepared', run: claimed, context, modelOptional } as const;
    });
    if (prepared.kind !== 'entered' || !prepared.value) return;
    if (prepared.value.kind === 'context_unreadable') {
      await retireUnreadableContext(p, authority, job.runId);
      return;
    }
    if (prepared.value.kind === 'revoked') {
      await retireRevoked(p, authority, job.runId, {
        generation: job.v === 2 ? (job.recordingGeneration ?? null) : null,
        wakeId: job.wakeId,
        expectedClaimId: job.expectedClaimId,
        legacyOrdinary: job.v === 2 && job.recordingGeneration === 1 && !!job.wakeId,
      });
      return;
    }
    const { run, context: c, modelOptional } = prepared.value;
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
    // Formation is the rules' decision. A model only chooses labels and routes for places that are
    // due, so with none due a reading-triggered run makes no call.
    if (modelOptional && !placesDue(c.facts)) {
      await settleUnadmitted(p, authority, purpose, nothingTrusted(c) ? 'no_trusted_support' : 'no_changes');
      return;
    }
    // A context too large for one request is not a reason to stop: the rules still apply what is due.
    const items = modelContextItems(c);
    if (!items) {
      await settleUnadmitted(p, authority, purpose, 'context_limit');
      return;
    }
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
        context: { bundleRef: `geography:${run.id}`, items },
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
    if (applied.kind === 'refused') {
      // Nothing can be applied under a ledger run that is already closed: settle by the rules, like a
      // refusal before admission. Otherwise the refusal is a revoked authority to clean up.
      if (outcome.kind === 'refused' && outcome.reason === 'run_closed')
        await settleUnadmitted(p, authority, purpose, 'run_closed');
      await retireRevoked(p, authority, run.id, {
        generation: run.recording!.source.generation,
        expectedClaimId: run.claimId,
      });
    }
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
