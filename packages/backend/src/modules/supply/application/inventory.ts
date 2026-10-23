import { ContentRequestStatusSchema } from '@knowscroll/contracts';
import type { CreateContentRequest } from '@knowscroll/contracts';
import { CONCEPTS } from '../../content/public.js';
import type { EncounterSnapshot } from '../../content/public.js';
import type { PersonalScopeTx } from '../../identity/public.js';
import type { CanonicalBrief, SupplyPorts, Demand, Source } from './ports.js';

export const sourceOf = (command: CreateContentRequest): Source | undefined =>
  command.intent.kind === 'variant' ? command.intent.source : command.intent.context;
export const sameRef = (
  a: { readonly assetId: string; readonly assetRevision: number },
  b: { readonly assetId: string; readonly assetRevision: number },
) => a.assetId.toLowerCase() === b.assetId.toLowerCase() && a.assetRevision === b.assetRevision;
export function briefOf(c: CreateContentRequest, source: EncounterSnapshot | undefined): CanonicalBrief | undefined {
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
  return catalogueBrief(c, subject, c.intent.format);
}
/** The shared brief of a catalogue meaning, built exactly as for a person's own catalogue ask. */
export function catalogueBrief(
  c: CreateContentRequest,
  subject: { readonly topicId: string; readonly facetId?: string },
  format: CanonicalBrief['format'],
): CanonicalBrief {
  return {
    version: 'supply-brief.v1',
    rights: 'shared_admitted',
    language: c.language,
    format,
    subject: {
      kind: 'catalogue',
      catalogueVersion: 'content-concepts.v1',
      topicId: subject.topicId,
      ...(subject.facetId === undefined ? {} : { facetId: subject.facetId }),
    },
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
export async function inventory(
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
export function checkedRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('SUPPLY_REVISION_INVALID');
  return value;
}
/** Current status is a read-only projection; global Content changes do not create personal hints. */
export async function snapshot(p: SupplyPorts, scope: PersonalScopeTx, d: Demand) {
  const source = sourceOf(d.command);
  const heads =
    d.status === 'ready' || d.status === 'requested' || d.status === 'deferred' || d.status === 'matching'
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
  // `requested` means a request nothing has started yet: a free-text ask still being matched. Once
  // a group stands behind it, production is real durable work and the request is preparing.
  if (d.status === 'matching')
    return ContentRequestStatusSchema.parse({ ...base, status: 'preparing', phase: 'requested' });
  if (d.status === 'requested' || d.status === 'deferred')
    return ContentRequestStatusSchema.parse({ ...base, status: 'preparing', phase: 'preparing' });
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
