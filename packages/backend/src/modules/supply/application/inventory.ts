import { ContentRequestStatusSchema } from '@knowscroll/contracts';
import type { CreateContentRequest } from '@knowscroll/contracts';
import { CONCEPTS } from '../../content/public.js';
import type { EncounterSnapshot } from '../../content/public.js';
import type { PersonalScopeTx } from '../../identity/public.js';
import { WAIT_LIMIT_MS, waitStartOf } from './commission.js';
import { typicalSeconds } from '../domain/ask-order.js';
import type { CanonicalBrief, SupplyPorts, Demand, Source } from './ports.js';

export const sourceOf = (command: CreateContentRequest): Source | undefined =>
  command.intent.kind === 'variant' || command.intent.kind === 'ask' ? command.intent.source : command.intent.context;
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
  // An ask from here carries a person's own question: it never has a deterministic shared brief.
  if (c.intent.kind === 'ask') return undefined;
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
/** A facet is not checked here: a facet brief's candidates all come from coverage bound to that facet. */
function matches(brief: CanonicalBrief, candidate: EncounterSnapshot): boolean {
  if (candidate.metadata.language !== brief.language || (brief.format !== 'either' && candidate.kind !== brief.format))
    return false;
  const s = brief.subject;
  return s.kind === 'variant'
    ? candidate.explanationUnitId === s.explanationUnitId
    : candidate.topics.some((t) => t.topicId === s.topicId && t.role === 'primary');
}
/** The admitted candidates that may serve a catalogue brief: by coverage for a facet, by primary topic otherwise. */
async function catalogueCandidates(
  p: SupplyPorts,
  scope: PersonalScopeTx,
  c: CreateContentRequest,
  brief: CanonicalBrief & { readonly subject: { readonly kind: 'catalogue' } },
): Promise<readonly EncounterSnapshot[]> {
  const { topicId, facetId } = brief.subject;
  if (facetId !== undefined) {
    const region = await p.readFacetCandidates(scope, {
      topicId,
      facetId,
      truthStatus: 'factual',
      capabilities: c.capabilities,
    });
    return region.kind === 'read' ? region.candidates.map((candidate) => candidate.encounter) : [];
  }
  return p.readCandidates(scope, {
    languages: [brief.language],
    formats: brief.format === 'either' ? ['reel', 'scroll'] : [brief.format],
    capabilities: c.capabilities,
    topicIds: [topicId],
    limit: 100,
  });
}
/**
 * Explanations content must not bind to: a fixed set, or a decision made once the candidate units are
 * known (planned demand re-derives what the person has met at the moment it binds).
 */
export type SkipExplanations =
  ReadonlySet<string> | ((candidateUnits: readonly string[]) => Promise<ReadonlySet<string>>);

/** One sorted Content lock batch. Private/source data is never submitted as retrieval text. */
export async function inventory(
  p: SupplyPorts,
  scope: PersonalScopeTx,
  c: CreateContentRequest,
  brief?: CanonicalBrief,
  skip: SkipExplanations = new Set(),
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
      : brief?.subject.kind === 'catalogue'
        ? await catalogueCandidates(p, scope, c, { ...brief, subject: brief.subject })
        : [];
  const serving = candidates.filter((x) => brief && matches(brief, x));
  const skipExplanations = typeof skip === 'function' ? await skip(serving.map((x) => x.explanationUnitId)) : skip;
  const heads = await p.lockCurrent(scope, {
    refs: [...(source ? [source] : []), ...serving.filter((x) => !skipExplanations.has(x.explanationUnitId))],
    capabilities: c.capabilities,
  });
  const sourceHead = source ? heads.find((x) => sameRef(x.ref, source)) : undefined;
  const ready = heads.find(
    (x) => x.encounter && brief && matches(brief, x.encounter) && !skipExplanations.has(x.encounter.explanationUnitId),
  );
  return { heads, sourceHead, ready };
}
/** How many of the latest finished ask orders the "usually" time is measured from. */
const TYPICAL_SAMPLE_WINDOW = 20;

export function checkedRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('SUPPLY_REVISION_INVALID');
  return value;
}
/** Current status is a read-only projection; global Content changes do not create personal hints. */
export async function snapshot(p: SupplyPorts, scope: PersonalScopeTx, d: Demand) {
  // An ask order depends on its source only until the order is made: its words and its research pages are fixed then,
  // so a source that was corrected or withdrawn since does not take the Scroll made for the person away.
  const source = d.askOrder ? undefined : sourceOf(d.command);
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
  // An open request past its wait limit reads as closed even when no job ever closed it (a poll that was
  // dead-lettered, a worker that stayed down). The next write freezes the same outcome.
  if (
    (d.status === 'requested' || d.status === 'deferred' || d.status === 'matching') &&
    p.now().getTime() - Date.parse(waitStartOf(d)) >= WAIT_LIMIT_MS
  )
    return ContentRequestStatusSchema.parse({
      ...base,
      requestRevision: checkedRevision(requestRevision + 1),
      status: 'unavailable',
      reason: 'could_not_prepare',
    });
  // How long an ask order usually takes, shown only when finished orders measured it (never a guess).
  const typical =
    d.command.intent.kind === 'ask' && d.status !== 'ready'
      ? typicalSeconds(await p.askLedger.recentWaitsSeconds(scope, TYPICAL_SAMPLE_WINDOW))
      : undefined;
  const usually = typical === undefined ? {} : { typicalSeconds: typical };
  // `requested` means a request nothing has started yet: a free-text ask still being matched. Once
  // a group stands behind it, production is real durable work and the request is preparing.
  if (d.status === 'matching')
    return ContentRequestStatusSchema.parse({ ...base, status: 'preparing', phase: 'requested', ...usually });
  if (d.status === 'requested' || d.status === 'deferred')
    return ContentRequestStatusSchema.parse({ ...base, status: 'preparing', phase: 'preparing', ...usually });
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
