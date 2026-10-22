import { z } from 'zod';
import {
  FormationPresentationFactSchema,
  FORMATION_PRESENTATION_POLICY,
  GeographyRevisionsSchema,
  ReadFormationPresentationSchema,
  FormationPresentationReadSchema,
  ClaimFormationPresentationSchema,
  FormationPresentationClaimReceiptSchema,
  FormationPresentationClaimAcceptanceSchema,
  AcknowledgeFormationPresentationSchema,
  FormationPresentationAcknowledgementSchema,
  SceneChunkSchema,
  supportsSceneV1,
  type FormationPresentationClaimReceipt,
  type ProblemCode,
} from '@knowscroll/contracts';
import type { GeographyApplied, GeographySceneInput } from '../../geography/public.js';
import type { PersonalScopeTx, PersonalAuthority } from '../../identity/public.js';
import type {
  FormationStore,
  NewFormationRecord,
  FormationPorts,
  FormationRecord,
  FormationResult,
  FormationUseCases,
} from './ports.js';
import { formationMaintenance } from './formation-recovery.js';
const Creation = z.strictObject({
  operation: z.enum(['create_system', 'establish_star', 'form_planet', 'add_region']),
  objectId: z.uuid(),
  parentId: z.uuid(),
  kind: z.enum(['system', 'star', 'planet', 'region']),
  objectRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  label: z
    .string()
    .min(1)
    .max(160)
    .refine((s) => s.trim().length > 0),
  truthStatus: z.enum(['factual', 'hypothetical']),
});
const Committed = z.strictObject({ recordedAt: z.iso.datetime(), targets: z.array(Creation).max(1000) });
/** Derives only delivery policy from actual committed creation operations. No proposal,
 * inferred birth, activity/label change, truncation or presentation claim is accepted here. */
export function formationOfCommitted(input: Parameters<GeographyApplied>[1]): NewFormationRecord | undefined {
  if (!input.committedCreations) return undefined;
  const committed = Committed.parse(input.committedCreations);
  if (!committed.targets.length) return undefined;
  const geography = GeographyRevisionsSchema.parse(input.geography);
  const kinds = {
    create_system: 'system',
    establish_star: 'star',
    form_planet: 'planet',
    add_region: 'region',
  } as const;
  if (
    committed.targets.some((t) => t.kind !== kinds[t.operation] || t.objectRevision !== geography.revision) ||
    new Set(committed.targets.map((t) => t.objectId)).size !== committed.targets.length
  )
    throw new Error('FORMATION_COMMITTED_IDENTITY');
  const common = {
    transitionId: input.transitionId,
    recordedAt: committed.recordedAt,
    geography,
    targetCount: committed.targets.length,
  };
  if (committed.targets.length > FORMATION_PRESENTATION_POLICY.maxTargets) return { ...common, limit: true };
  const ordered = [...committed.targets].sort((a, b) => a.objectId.localeCompare(b.objectId));
  const planet = ordered.find((t) => t.operation === 'form_planet');
  const system = planet
    ? ordered.find(
        (t) =>
          t.operation === 'create_system' && t.objectId === planet.parentId && t.truthStatus === planet.truthStatus,
      )
    : undefined;
  const star = system
    ? ordered.find(
        (t) =>
          t.operation === 'establish_star' && t.parentId === system.objectId && t.truthStatus === system.truthStatus,
      )
    : undefined;
  const fact = FormationPresentationFactSchema.parse({
    transitionId: common.transitionId,
    recordedAt: common.recordedAt,
    geography,
    targets: ordered.map(({ operation: _operation, ...target }) => target),
    sequence: planet
      ? {
          kind: 'planet',
          planetId: planet.objectId,
          durationMs: FORMATION_PRESENTATION_POLICY.fullDurationMs,
          ...(system && star ? { newSystem: { systemId: system.objectId, starId: star.objectId } } : {}),
        }
      : { kind: 'final_still' },
  });
  return { ...common, fact, limit: false };
}
/** The owning adapter invokes this inside Geography's actual delta/root transaction. */
export function makeRecordFormation(store: Pick<FormationStore, 'record'>): GeographyApplied {
  return async (scope: PersonalScopeTx, input) => {
    const record = formationOfCommitted(input);
    if (record) await store.record(scope, record);
  };
}

const version = FORMATION_PRESENTATION_POLICY.version;
const refused = (code: ProblemCode) => ({ kind: 'refused' as const, code });
const accepted = <T>(value: T): FormationResult<T> => ({ kind: 'accepted', value });
function scopeFields(scope: PersonalScopeTx, personalWatermark: number) {
  return { universeId: scope.authority.universeId, privacyEpoch: scope.authority.privacyEpoch, personalWatermark };
}
/** ALL committed targets must still exist with exact identity in the current manifest's real
 * chunks. A ready ancestor, stale chunk, alias or old manifest is never a substitute. */
async function projection(p: FormationPorts, scope: PersonalScopeTx, input: GeographySceneInput, row: FormationRecord) {
  const state = await p.scenes.state(scope),
    m = state?.manifest;
  if (
    !row.fact ||
    !m ||
    state.failure?.geographyRevision === input.geography.revision ||
    m.revisions.geographyRevision !== input.geography.revision ||
    m.revisions.structureRevision !== input.geography.structureRevision ||
    m.revisions.activityRevision !== input.geography.activityRevision
  )
    return undefined;
  const refs = m.chunks.filter((ref) => row.fact!.targets.some((t) => ref.objectIds.includes(t.objectId)));
  if (refs.length > FORMATION_PRESENTATION_POLICY.maxTargets) return undefined;
  const descriptors = [];
  for (const ref of refs) {
    const stored = await p.scenes.chunk(scope, ref.chunkId, ref.sceneRevision);
    if (!stored) return undefined;
    const chunk = SceneChunkSchema.parse(stored.chunk);
    if (
      chunk.chunkId !== ref.chunkId ||
      chunk.revisions.sceneRevision !== ref.sceneRevision ||
      chunk.objects.length !== ref.objectIds.length ||
      chunk.objects.some((d) => !ref.objectIds.includes(d.objectId))
    )
      return undefined;
    descriptors.push(...chunk.objects);
  }
  for (const t of row.fact.targets) {
    const objects = input.objects.filter((o) => o.id === t.objectId),
      ds = descriptors.filter((d) => d.objectId === t.objectId);
    const o = objects[0],
      d = ds[0];
    if (
      objects.length !== 1 ||
      ds.length !== 1 ||
      !o ||
      !d ||
      o.kind !== t.kind ||
      o.parent.id !== t.parentId ||
      o.objectRevision !== t.objectRevision ||
      o.label !== t.label ||
      o.truthStatus !== t.truthStatus ||
      o.originTransitionId !== row.transitionId ||
      d.kind !== t.kind ||
      d.parentId !== t.parentId ||
      d.label !== t.label ||
      d.truthStatus !== t.truthStatus ||
      d.originTransitionId !== row.transitionId
    )
      return undefined;
  }
  return m.revisions.sceneRevision;
}
export function makeFormationPresentations(p: FormationPorts): FormationUseCases {
  const enter = async <T>(
    authority: PersonalAuthority,
    work: (scope: PersonalScopeTx) => Promise<FormationResult<T>>,
  ): Promise<FormationResult<T>> => {
    const result = await p.withScope(authority, async (scope) =>
      (await p.ownerActive(scope)) ? work(scope) : refused('UNIVERSE_UNAVAILABLE'),
    );
    return result.kind === 'entered'
      ? result.value
      : refused(result.refusal.kind === 'epoch_changed' ? 'PRIVACY_EPOCH_CHANGED' : 'UNIVERSE_UNAVAILABLE');
  };
  const current = async (
    scope: PersonalScopeTx,
    row: FormationRecord | undefined,
    receipt: FormationPresentationClaimReceipt,
    input: GeographySceneInput | undefined,
  ) => {
    if (receipt.outcome === 'not_claimed')
      return { status: 'final' as const, observedAt: p.now().toISOString(), reason: 'not_claimed' as const };
    const ready = Boolean(
      row?.claim &&
      !row.terminal &&
      row.claim.claimId === receipt.claim.claimId &&
      row.claim.attemptNonce === receipt.attemptNonce &&
      row.claim.claimedAt === receipt.claim.claimedAt &&
      row.claim.expiresAt === receipt.claim.expiresAt &&
      input &&
      p.now().getTime() < Date.parse(receipt.claim.expiresAt) &&
      (await projection(p, scope, input, row)),
    );
    // Observe time AFTER readiness queries: a slow database must not mint an already expired
    // active status from the clock sampled before proving the current manifest.
    const observedAt = p.now().toISOString();
    if (Date.parse(observedAt) >= Date.parse(receipt.claim.expiresAt))
      return { status: 'final' as const, observedAt, reason: 'expired' as const };
    if (row?.terminal) return { status: 'final' as const, observedAt, reason: 'terminal' as const };
    if (!ready) return { status: 'final' as const, observedAt, reason: 'unavailable' as const };
    return {
      status: 'active' as const,
      observedAt,
      claimId: receipt.claim.claimId,
      expiresAt: receipt.claim.expiresAt,
    };
  };
  return {
    ...formationMaintenance(p),
    async read(authority, input) {
      const parsed = ReadFormationPresentationSchema.safeParse(input);
      if (!parsed.success) return refused('INVALID_REQUEST');
      const q = parsed.data;
      return enter(authority, async (scope) => {
        const read = await p.readInput(scope);
        if (read.kind === 'refused') return refused('UNIVERSE_UNAVAILABLE');
        const state = await p.scenes.state(scope),
          fields = {
            version,
            readId: q.readId,
            target: q.target,
            capabilities: q.capabilities,
            scope: scopeFields(scope, read.kind === 'read' ? read.input.personalRevision : read.personalRevision),
            recordedAt: p.now().toISOString(),
            currentGeography: read.kind === 'read' ? read.input.geography : read.geography,
            sceneRevision: state?.manifest?.revisions.sceneRevision ?? 0,
          };
        const reply = (s: unknown) => accepted(FormationPresentationReadSchema.parse(s));
        if (!supportsSceneV1(q.capabilities)) return reply({ ...fields, status: 'unsupported_version' });
        if (read.kind !== 'read') return reply({ ...fields, status: 'unavailable', reason: read.reason });
        const row = await p.store.read(scope, q.target);
        if (!row)
          return reply({
            ...fields,
            ...(q.target.kind === 'next'
              ? { status: 'none' }
              : { status: 'unavailable', reason: 'target_unavailable' }),
          });
        if (row.limit) return reply({ ...fields, status: 'unavailable', reason: 'limit' });
        if (!(await projection(p, scope, read.input, row))) {
          const pending = await p.scenes.pending(scope);
          const failure =
            state?.failure?.geographyRevision === read.input.geography.revision ? state.failure : undefined;
          const currentManifest =
            state?.manifest?.revisions.geographyRevision === read.input.geography.revision &&
            state.manifest.revisions.structureRevision === read.input.geography.structureRevision &&
            state.manifest.revisions.activityRevision === read.input.geography.activityRevision;
          const reason =
            failure?.reason ??
            (currentManifest
              ? 'target_unavailable'
              : pending?.geographyRevision === read.input.geography.revision &&
                  pending.personalRevision <= read.input.personalRevision
                ? 'projection_pending'
                : 'temporarily_unavailable');
          return reply({ ...fields, status: 'unavailable', reason });
        }
        const until = new Date(
          Date.parse(row.recordedAt) + FORMATION_PRESENTATION_POLICY.freshnessSeconds * 1000,
        ).toISOString();
        const eligibility = row.terminal
          ? { status: 'final', reason: 'terminal' }
          : row.claim
            ? { status: 'final', reason: 'already_claimed' }
            : Date.parse(fields.recordedAt) >= Date.parse(until)
              ? { status: 'final', reason: 'late' }
              : { status: 'claimable', until };
        return reply({ ...fields, status: 'available', fact: row.fact, eligibility });
      });
    },
    async claim(authority, input) {
      const parsed = ClaimFormationPresentationSchema.safeParse(input);
      if (!parsed.success) return refused('INVALID_REQUEST');
      const q = parsed.data;
      return enter(authority, async (scope) => {
        const operation = 'scenes.formation-claim.v1' as const,
          key = { commandId: q.commandId, operation, requestHash: p.hash(operation, q), outcomeVersion: 1 as const };
        const lookup = await p.receipts.find(scope, key);
        if (lookup.kind === 'refused') return lookup;
        const read = await p.readInput(scope);
        if (read.kind === 'refused') return refused('UNIVERSE_UNAVAILABLE');
        const row = await p.store.read(scope, { kind: 'transition', transitionId: q.transitionId });
        let receipt: FormationPresentationClaimReceipt,
          revision = read.kind === 'read' ? read.input.personalRevision : read.personalRevision;
        if (lookup.kind === 'replay') receipt = FormationPresentationClaimReceiptSchema.parse(lookup.outcome);
        else {
          const projected =
            row &&
            !row.limit &&
            !row.claim &&
            !row.terminal &&
            read.kind === 'read' &&
            (await projection(p, scope, read.input, row));
          const now = p.now(),
            recordedAt = now.toISOString();
          const reason = row?.terminal
            ? 'terminal'
            : row?.claim
              ? 'already_claimed'
              : row && now.getTime() >= Date.parse(row.recordedAt) + 300_000
                ? 'expired'
                : 'unavailable';
          const ready =
            projected &&
            row &&
            now.getTime() >= Date.parse(row.recordedAt) &&
            now.getTime() < Date.parse(row.recordedAt) + 300_000;
          receipt = FormationPresentationClaimReceiptSchema.parse({
            commandId: q.commandId,
            transitionId: q.transitionId,
            attemptNonce: q.attemptNonce,
            recordedAt,
            ...(ready
              ? {
                  outcome: 'claimed',
                  claim: {
                    claimId: p.newId(),
                    claimedAt: recordedAt,
                    expiresAt: new Date(now.getTime() + 30_000).toISOString(),
                  },
                }
              : { outcome: 'not_claimed', reason }),
          });
          await p.receipts.insert(scope, key);
          if (receipt.outcome === 'claimed') {
            const claim = { ...receipt.claim, attemptNonce: q.attemptNonce };
            await p.store.claim(scope, q.transitionId, claim);
            await p.enqueueExpiry(
              scope,
              {
                universeId: scope.authority.universeId,
                privacyEpoch: scope.authority.privacyEpoch,
                transitionId: q.transitionId,
                claimId: claim.claimId,
              },
              new Date(claim.expiresAt),
            );
          }
          await p.receipts.complete(scope, q.commandId, receipt);
          revision = await p.advance(scope);
          await p.notify(scope, revision);
        }
        if (
          receipt.commandId !== q.commandId ||
          receipt.transitionId !== q.transitionId ||
          receipt.attemptNonce !== q.attemptNonce
        )
          throw new Error('FORMATION_RECEIPT_IDENTITY');
        const freshRow =
          lookup.kind === 'replay'
            ? row
            : await p.store.read(scope, { kind: 'transition', transitionId: q.transitionId });
        return accepted(
          FormationPresentationClaimAcceptanceSchema.parse({
            version,
            scope: scopeFields(scope, revision),
            receipt,
            replayed: lookup.kind === 'replay',
            current: await current(scope, freshRow, receipt, read.kind === 'read' ? read.input : undefined),
          }),
        );
      });
    },
    async acknowledge(authority, input) {
      const parsed = AcknowledgeFormationPresentationSchema.safeParse(input);
      if (!parsed.success) return refused('INVALID_REQUEST');
      const q = parsed.data;
      return enter(authority, async (scope) => {
        const operation = 'scenes.formation-acknowledge.v1' as const,
          key = { commandId: q.commandId, operation, requestHash: p.hash(operation, q), outcomeVersion: 1 as const };
        const lookup = await p.receipts.find(scope, key);
        if (lookup.kind === 'refused') return lookup;
        if (lookup.kind === 'replay') {
          const old = FormationPresentationAcknowledgementSchema.parse(lookup.outcome);
          if (
            old.commandId !== q.commandId ||
            old.transitionId !== q.transitionId ||
            old.claimId !== q.claimId ||
            old.attemptNonce !== q.attemptNonce ||
            old.requestedDisposition !== q.disposition
          )
            throw new Error('FORMATION_RECEIPT_IDENTITY');
          return accepted({ ...old, replayed: true });
        }
        const row = await p.store.read(scope, { kind: 'transition', transitionId: q.transitionId });
        if (!row?.claim || row.claim.claimId !== q.claimId || row.claim.attemptNonce !== q.attemptNonce)
          return refused('CONFLICT');
        const now = p.now(),
          expired = now.getTime() >= Date.parse(row.claim.expiresAt);
        const disposition = row.terminal?.disposition ?? (expired ? 'skipped' : q.disposition);
        await p.receipts.insert(scope, key);
        if (
          !row.terminal &&
          !(await p.store.terminal(
            scope,
            q.transitionId,
            q.claimId,
            disposition,
            expired ? row.claim.expiresAt : now.toISOString(),
          ))
        )
          throw new Error('FORMATION_STATE_CONFLICT');
        const revision = await p.advance(scope);
        const value = FormationPresentationAcknowledgementSchema.parse({
          version,
          scope: scopeFields(scope, revision),
          commandId: q.commandId,
          transitionId: q.transitionId,
          claimId: q.claimId,
          attemptNonce: q.attemptNonce,
          recordedAt: now.toISOString(),
          replayed: false,
          requestedDisposition: q.disposition,
          disposition,
          outcome: row.terminal || expired ? 'already_terminal' : 'recorded',
        });
        await p.receipts.complete(scope, q.commandId, value);
        await p.notify(scope, revision);
        return accepted(value);
      });
    },
  };
}
