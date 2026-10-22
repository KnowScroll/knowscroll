import {
  parsePersonalRecordingPurpose,
  type CheckPersonalRecordingRun,
  type PersonalRecordingPurpose,
} from '../../../reasoning/public.js';
import type {
  CartographerPorts,
  GeographyPorts,
  RunCartographer,
  PublishGeographyDelta,
  GeographyRun,
  GeographyAccountingHeader,
} from './ports.js';
import { GEOGRAPHY_POLICY } from '../domain/policy.js';
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
  delivered?: { readonly generation: number | null; readonly wakeId?: string; readonly legacyOrdinary?: boolean },
) {
  await p.withScope(authority, async (scope) => {
    let h: GeographyAccountingHeader | undefined,
      revoked = false,
      legacyDelivery = false;
    const result = await p.harness.readPersonalRunAccounting(scope, runId, async (current, owner) => {
      h = await p.store.accountingHeader(current, runId);
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
          : !job.expectedClaimId ||
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
      if (!p.enabled() || !(await p.permitted(scope))) {
        await p.store.writeRun(scope, {
          ...consumed,
          status: 'blocked',
          outcome: p.enabled() ? 'budget_unavailable' : 'disabled',
        });
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
      if (!(await p.ownerActive(scope)) || !(await p.permitted(scope))) return undefined;
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
    const applied = await p.harness.withPersonalApply(authority, purpose, async (cap) => {
      const scope = cap.personal,
        state = await p.store.state(scope),
        current = await p.store.header(scope, run.id);
      if (!current || state.activeRunId !== run.id || current.claimId !== run.claimId || current.status !== 'prepared')
        return;
      const {
        claimId: _claim,
        claimUntil: _until,
        claimWakeClaimId: _wake,
        normalWakeId: _normal,
        ...released
      } = current;
      if (
        outcome.kind === 'unknown' ||
        outcome.kind === 'quota_unavailable' ||
        outcome.kind === 'budget_exhausted' ||
        outcome.kind === 'refused'
      ) {
        await p.store.writeRun(scope, {
          ...released,
          status: outcome.kind === 'unknown' || current.outcome === 'unknown' ? 'unknown' : 'blocked',
          outcome: outcome.kind === 'refused' ? outcome.reason : outcome.kind,
        });
        return;
      }
      let status: GeographyRun['status'] = 'rejected',
        reason: string = outcome.kind,
        closed = false;
      const close = async () => {
        if (
          (await p.harness.closePersonalRun(cap, { runId: run.id, state: 'completed', recordingPurpose: purpose })) !==
          'closed'
        )
          throw new Error('GEOGRAPHY_HARNESS_NOT_CLOSED');
        closed = true;
      };
      if (!p.enabled() || !(await p.permitted(scope))) {
        status = 'stale';
        reason = 'scope_or_permit_changed';
      } else if (state.desiredRevision !== c.desiredRevision) {
        status = 'stale';
        reason = 'desired_revision_changed';
      } else if (outcome.kind === 'proposed') {
        const result = await applyProposal(p, cap, run.id, c, outcome.output, close);
        if (result.kind === 'refused') {
          status = result.reason === 'no_changes' ? 'insufficient' : 'stale';
          reason = result.reason;
        } else {
          if (result.kind === 'replayed') await close();
          status = 'accepted';
          reason = 'applied';
        }
      }
      if (
        !closed &&
        (await p.harness.closePersonalRun(cap, { runId: run.id, state: 'cancelled', recordingPurpose: purpose })) !==
          'closed'
      )
        throw new Error('GEOGRAPHY_HARNESS_NOT_CLOSED');
      await p.store.writeRun(scope, {
        ...released,
        status,
        outcome: reason,
        ...(outcome.kind === 'proposed' ? { proposal: outcome.output, attemptId: outcome.attemptId } : {}),
      });
      const updated = await p.store.state(scope),
        idle = { ...updated, activeRunId: undefined };
      await p.store.writeState(scope, idle);
      if (updated.desiredRevision > run.desiredRevision && updated.desiredSource?.generation === cap.generation)
        await ensureCartography(p, cap, idle);
    });
    if (applied.kind === 'refused') await retireRevoked(p, authority, run.id);
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
