import {
  CreateContentRequestSchema,
  ContentRequestReceiptSchema,
  ContentRequestStatusSchema,
  CancelContentRequestSchema,
  CancelContentRequestReceiptSchema,
  ReadContentRequestSchema,
} from '@knowscroll/contracts';
import type { CreateContentRequest } from '@knowscroll/contracts';
import { CONCEPTS } from '../../content/public.js';
import type { EncounterSnapshot } from '../../content/public.js';
import type { PersonalScopeTx } from '../../identity/public.js';
import type {
  CanonicalBrief,
  SupplyPorts,
  Demand,
  Source,
  CreateRequest,
  ReadRequest,
  CancelRequest,
  ResolveRequest,
  RecordPlannedDemand,
} from './ports.js';

const sourceOf = (command: CreateContentRequest): Source | undefined =>
  command.intent.kind === 'variant' ? command.intent.source : command.intent.context;
const sameRef = (
  a: { readonly assetId: string; readonly assetRevision: number },
  b: { readonly assetId: string; readonly assetRevision: number },
) => a.assetId.toLowerCase() === b.assetId.toLowerCase() && a.assetRevision === b.assetRevision;
function briefOf(c: CreateContentRequest, source: EncounterSnapshot | undefined): CanonicalBrief | undefined {
  // The admitted catalogue/production policy currently supports English only. Do not put an
  // arbitrary bounded language string or a private-use locale into a shared canonical brief.
  if (c.language !== 'en') return undefined;
  if (c.intent.kind === 'variant')
    return source && source.kind !== c.intent.to
      ? {
          version: 'supply-brief.v1',
          rights: 'shared_admitted',
          language: c.language,
          format: c.intent.to,
          subject: {
            kind: 'variant',
            explanationUnitId: source.explanationUnitId,
            source: { assetId: source.assetId, assetRevision: source.assetRevision },
          },
        }
      : undefined;
  // A contextual ask has additional meaning that this deterministic catalogue matcher cannot admit.
  if (c.intent.context || c.intent.subject.kind !== 'catalogue') return undefined;
  const subject = c.intent.subject;
  const topic = CONCEPTS.find((t) => t.id === subject.topicId);
  if (!topic || (subject.facetId && !topic.facets.some((f) => f.id === subject.facetId))) return undefined;
  return {
    version: 'supply-brief.v1',
    rights: 'shared_admitted',
    language: c.language,
    format: c.intent.format,
    subject,
  };
}
function matches(brief: CanonicalBrief, candidate: EncounterSnapshot): boolean {
  if (candidate.metadata.language !== brief.language || (brief.format !== 'either' && candidate.kind !== brief.format))
    return false;
  const s = brief.subject;
  return s.kind === 'variant'
    ? candidate.explanationUnitId === s.explanationUnitId
    : candidate.topics.some((t) => t.topicId === s.topicId && t.role === 'primary') &&
        (!s.facetId || candidate.facets.includes(s.facetId));
}
/** One sorted Content lock batch. Private/source data is never submitted as retrieval text. */
async function inventory(
  p: SupplyPorts,
  scope: PersonalScopeTx,
  c: CreateContentRequest,
  brief?: CanonicalBrief,
  skipExplanations: ReadonlySet<string> = new Set(),
) {
  const source = sourceOf(c);
  const sourceSnapshot = source ? await p.readExact(scope, { ...source, capabilities: c.capabilities }) : undefined;
  const candidates =
    brief?.subject.kind === 'variant' && sourceSnapshot
      ? (
          await Promise.all(
            sourceSnapshot.siblings.map((ref) => p.readExact(scope, { ...ref, capabilities: c.capabilities })),
          )
        ).filter((e): e is EncounterSnapshot => e !== undefined)
      : brief
        ? await p.readCandidates(scope, {
            languages: [brief.language],
            formats: brief.format === 'either' ? ['reel', 'scroll'] : [brief.format],
            capabilities: c.capabilities,
            ...(brief.subject.kind === 'catalogue' ? { topicIds: [brief.subject.topicId] } : {}),
            limit: 100,
          })
        : [];
  const heads = await p.lockCurrent(scope, {
    refs: [
      ...(source ? [source] : []),
      ...candidates.filter((x) => brief && matches(brief, x) && !skipExplanations.has(x.explanationUnitId)),
    ],
    capabilities: c.capabilities,
  });
  const sourceHead = source ? heads.find((x) => sameRef(x.ref, source)) : undefined;
  const ready = heads.find(
    (x) => x.encounter && brief && matches(brief, x.encounter) && !skipExplanations.has(x.encounter.explanationUnitId),
  );
  return { heads, sourceHead, ready };
}
function checkedRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('SUPPLY_REVISION_INVALID');
  return value;
}
/** Current status is a read-only projection; global Content changes do not create personal hints. */
async function snapshot(p: SupplyPorts, scope: PersonalScopeTx, d: Demand) {
  const source = sourceOf(d.command);
  const heads =
    d.status === 'ready' || d.status === 'requested' || d.status === 'deferred'
      ? await p.lockCurrent(scope, {
          refs: [...(source ? [source] : []), ...(d.content ? [d.content] : [])],
          capabilities: d.command.capabilities,
        })
      : [];
  const sourceHead = source ? heads.find((x) => sameRef(x.ref, source)) : undefined;
  const contentHead = d.content ? heads.find((x) => sameRef(x.ref, d.content!)) : undefined;
  const delta =
    (sourceHead && d.sourceAvailabilityRevision ? sourceHead.availabilityRevision - d.sourceAvailabilityRevision : 0) +
    (contentHead && d.contentAvailabilityRevision
      ? contentHead.availabilityRevision - d.contentAvailabilityRevision
      : 0);
  if (delta < 0) throw new Error('SUPPLY_AVAILABILITY_REGRESSED');
  const requestRevision = checkedRevision(d.requestRevision + delta);
  const updatedAt = [d.updatedAt, ...heads.map((h) => h.changedAt)].sort().at(-1)!;
  const base = {
    version: 'content-request-status.v1' as const,
    requestId: d.id,
    privacyEpoch: scope.authority.privacyEpoch,
    requestRevision,
    revision: scope.revisionAtEntry,
    createdAt: d.createdAt,
    updatedAt,
  };
  if (d.status === 'cancelled') return ContentRequestStatusSchema.parse({ ...base, status: 'cancelled' });
  if (d.status === 'unavailable')
    return ContentRequestStatusSchema.parse({ ...base, status: 'unavailable', reason: d.reason });
  if ((source && !sourceHead?.encounter) || (d.status === 'ready' && !contentHead?.encounter))
    return ContentRequestStatusSchema.parse({ ...base, status: 'unavailable', reason: 'source_unavailable' });
  if (d.status === 'requested' || d.status === 'deferred')
    return ContentRequestStatusSchema.parse({ ...base, status: 'preparing', phase: 'requested' });
  const e = contentHead!.encounter!;
  return ContentRequestStatusSchema.parse({
    ...base,
    status: 'ready',
    content: {
      assetId: e.assetId,
      assetRevision: e.assetRevision,
      explanationUnitId: e.explanationUnitId,
      metadata: e.metadata,
    },
  });
}
export function makeCreateRequest(p: SupplyPorts): CreateRequest {
  return async (authority, command) => {
    const c = CreateContentRequestSchema.parse(command);
    const result = await p.withScope(authority, async (scope) => {
      const previous = await p.receipts.find(scope, 'supply.create', c.commandId, c);
      if (previous.kind === 'replay')
        return {
          kind: 'ok',
          value: ContentRequestReceiptSchema.parse({
            ...ContentRequestReceiptSchema.parse(previous.outcome),
            replayed: true,
          }),
        } as const;
      if (previous.kind !== 'new') return { kind: 'refused', reason: previous.reason } as const;
      const source = sourceOf(c);
      if (source && !(await p.checkSource(scope, source))) return { kind: 'refused', reason: 'stale_source' } as const;
      // This preliminary immutable read grants no authority; one sorted lock batch below
      // rechecks current admission after waiting before any receipt or private mutation.
      const preliminary = source ? await p.readExact(scope, { ...source, capabilities: c.capabilities }) : undefined;
      const brief = briefOf(c, preliminary);
      const current = await inventory(p, scope, c, brief);
      if (source && (!(await p.checkSource(scope, source)) || !current.sourceHead?.encounter))
        return { kind: 'refused', reason: 'source_unavailable' } as const;
      const id = p.newId(),
        now = p.now().toISOString();
      await p.receipts.insert(scope, 'supply.create', c.commandId, c);
      let demand: Demand = {
        id,
        command: c,
        status: 'unavailable',
        decision: 'refuse',
        reason: 'unsupported_request',
        requestRevision: 1,
        revision: 0,
        createdAt: now,
        updatedAt: now,
        ...(current.sourceHead ? { sourceAvailabilityRevision: current.sourceHead.availabilityRevision } : {}),
      };
      if (brief && current.ready?.encounter)
        demand = {
          ...demand,
          brief,
          status: 'ready',
          decision: 'reuse',
          reason: undefined,
          content: current.ready.encounter,
          contentAvailabilityRevision: current.ready.availabilityRevision,
        };
      else if (brief) {
        const work = await p.store.joinOrCreate(scope, brief, p.newId());
        demand = {
          ...demand,
          brief,
          status: 'requested',
          reason: undefined,
          workId: work.id,
          decision: work.joined ? 'join' : 'create',
        };
      }
      const revision = await p.advance(scope);
      await p.store.insert(scope, { ...demand, revision });
      if (demand.status === 'requested') await p.enqueue(scope, id);
      const receipt = ContentRequestReceiptSchema.parse({
        version: 'content-request-receipt.v1',
        commandId: c.commandId,
        requestId: id,
        recordedAt: now,
        privacyEpoch: scope.authority.privacyEpoch,
        revision,
        replayed: false,
        outcome: 'accepted',
      });
      await p.receipts.complete(scope, c.commandId, receipt);
      await p.notify(scope, revision, id);
      return { kind: 'ok', value: receipt } as const;
    });
    return result.kind === 'entered' ? result.value : { kind: 'refused', reason: 'scope_refused' };
  };
}
export function makeReadRequest(p: SupplyPorts): ReadRequest {
  return async (authority, input) => {
    const c = ReadContentRequestSchema.parse(input);
    const result = await p.withScope(authority, async (scope) => {
      const d = await p.store.read(scope, c.requestId);
      return d
        ? ({ kind: 'ok', value: await snapshot(p, scope, d) } as const)
        : ({ kind: 'refused', reason: 'not_found' } as const);
    });
    return result.kind === 'entered' ? result.value : { kind: 'refused', reason: 'scope_refused' };
  };
}
export function makeCancelRequest(p: SupplyPorts): CancelRequest {
  return async (authority, command) => {
    const c = CancelContentRequestSchema.parse(command);
    const result = await p.withScope(authority, async (scope) => {
      const previous = await p.receipts.find(scope, 'supply.cancel', c.commandId, c);
      if (previous.kind === 'replay')
        return {
          kind: 'ok',
          value: CancelContentRequestReceiptSchema.parse({
            ...CancelContentRequestReceiptSchema.parse(previous.outcome),
            replayed: true,
          }),
        } as const;
      if (previous.kind !== 'new') return { kind: 'refused', reason: previous.reason } as const;
      const d = await p.store.read(scope, c.requestId);
      if (!d) return { kind: 'refused', reason: 'not_found' } as const;
      const current = await snapshot(p, scope, d),
        now = p.now().toISOString();
      await p.receipts.insert(scope, 'supply.cancel', c.commandId, c);
      const revision = await p.advance(scope);
      const outcome =
        current.status === 'cancelled'
          ? 'already_cancelled'
          : current.status === 'preparing'
            ? 'cancelled'
            : 'already_closed';
      if (outcome === 'cancelled')
        await p.store.finish(scope, {
          ...d,
          status: 'cancelled',
          reason: undefined,
          revision,
          requestRevision: checkedRevision(current.requestRevision + 1),
          updatedAt: now,
        });
      // A pending row can already project unavailable after a shared Content withdrawal.
      // Respect that public outcome and freeze its own terminal state, rather than rename it
      // cancelled or allow a later resolver to revive it after this already_closed receipt.
      if ((d.status === 'requested' || d.status === 'deferred') && current.status === 'unavailable')
        await p.store.finish(scope, {
          ...d,
          status: 'unavailable',
          reason: current.reason,
          revision,
          requestRevision: checkedRevision(current.requestRevision + 1),
          updatedAt: now,
        });
      const receipt = CancelContentRequestReceiptSchema.parse({
        version: 'content-request-cancel-receipt.v1',
        commandId: c.commandId,
        requestId: c.requestId,
        recordedAt: now,
        privacyEpoch: scope.authority.privacyEpoch,
        revision,
        replayed: false,
        outcome,
      });
      await p.receipts.complete(scope, c.commandId, receipt);
      await p.notify(scope, revision, d.id);
      return { kind: 'ok', value: receipt } as const;
    });
    return result.kind === 'entered' ? result.value : { kind: 'refused', reason: 'scope_refused' };
  };
}
/** One recipient per transaction. No shared-work lock is held while acquiring any other root. */
export function makeResolveRequest(p: SupplyPorts): ResolveRequest {
  return async (job) => {
    await p.withScope(
      {
        universeId: job.universeId,
        privacyEpoch: job.privacyEpoch,
        actor: { kind: 'system', purpose: 'supply.resolve' },
      },
      async (scope) => {
        if (!(await p.ownerActive(scope))) return;
        const d = await p.store.read(scope, job.requestId);
        if (!d || d.status !== 'requested' || !d.brief) return;
        const inventoryNow = await inventory(p, scope, d.command, d.brief);
        const current = await snapshot(p, scope, d);
        const source = sourceOf(d.command);
        const validSource =
          !source ||
          (inventoryNow.sourceHead?.encounter &&
            (await p.checkSource(scope, {
              exposureId: source.exposureId,
              assetId: source.assetId,
              assetRevision: source.assetRevision,
            })));
        if (!(await p.ownerActive(scope))) return;
        const revision = await p.advance(scope),
          now = p.now().toISOString();
        const ready = validSource ? inventoryNow.ready : undefined;
        const next: Demand = {
          ...d,
          revision,
          requestRevision: checkedRevision(current.requestRevision + 1),
          updatedAt: now,
          status: ready?.encounter ? 'ready' : 'unavailable',
          reason: ready?.encounter ? undefined : validSource ? 'budget_unavailable' : 'source_unavailable',
          ...(ready?.encounter
            ? { content: ready.encounter, contentAvailabilityRevision: ready.availabilityRevision }
            : {}),
          ...(inventoryNow.sourceHead
            ? { sourceAvailabilityRevision: inventoryNow.sourceHead.availabilityRevision }
            : {}),
        };
        await p.store.finish(scope, next);
        if (d.workId) await p.store.closeWork(scope, d.workId);
        await p.notify(scope, revision, d.id);
      },
    );
  };
}

/**
 * The Planner's missing-supply opportunity becomes private demand. The brief is built exactly like
 * a person's catalogue ask, so Reuse and Join/Create-group follow the same deterministic rules.
 * Nothing is queued: a deferred demand stays on its shared group until a production path binds it.
 * No receipt is written (the caller's accepted plan is the idempotency boundary) and no client
 * hint is sent (planned demand is not a request the person made).
 */
export function makeRecordPlannedDemand(p: SupplyPorts): RecordPlannedDemand {
  return async (scope, input) => {
    const topicId = input.topicIds.find((id) => CONCEPTS.some((topic) => topic.id === id));
    if (topicId === undefined) return { kind: 'unsupported' };
    const command: CreateContentRequest = {
      version: 'content-request.v1',
      commandId: p.newId(),
      intent: {
        kind: 'topic',
        subject: { kind: 'catalogue', catalogueVersion: 'content-concepts.v1', topicId },
        format: input.format,
      },
      language: input.language,
      capabilities: input.capabilities,
    };
    const brief = briefOf(command, undefined);
    if (!brief) return { kind: 'unsupported' };
    const id = p.newId(),
      now = p.now().toISOString();
    const demand: Demand = {
      id,
      command,
      brief,
      planned: { runId: input.plannerRunId, slot: input.slot },
      requestRevision: 1,
      revision: scope.revisionAtEntry,
      createdAt: now,
      updatedAt: now,
      status: 'deferred',
      decision: 'join',
    };
    const reusable = (await inventory(p, scope, command, brief, new Set(input.alreadyMet))).ready;
    // Plan after plan may ask for the same thing. One open waiter per brief is enough: a deferred one
    // is still waiting, and a ready one still has content to bind.
    const open = await p.store.findOpenPlanned(scope, brief);
    if (open && (open.state === 'deferred' || reusable?.encounter))
      return { kind: 'already_recorded', requestId: open.id };
    if (reusable?.encounter) {
      await p.store.insert(scope, {
        ...demand,
        status: 'ready',
        decision: 'reuse',
        content: reusable.encounter,
        contentAvailabilityRevision: reusable.availabilityRevision,
      });
      return { kind: 'ready', requestId: id };
    }
    const work = await p.store.joinOrCreate(scope, brief, p.newId());
    await p.store.insert(scope, { ...demand, workId: work.id, decision: work.joined ? 'join' : 'create' });
    return { kind: 'deferred', requestId: id, joined: work.joined };
  };
}
