import { z } from 'zod';
import {
  ActivateOfferResponseSchema,
  ClientCapabilities,
  NavigationOutcomeSchema,
  type EncounterOffer,
  type ExposureContextResponse,
  type NavigationOutcome,
  type ProblemCode,
} from '@knowscroll/contracts';
import type { ComposerSnapshot } from '../../composer/public.js';
import type { EncounterRef, EncounterSnapshot, ContinuityLink } from '../../content/public.js';
import type { PersonalAuthority, PersonalScopeTx } from '../../identity/public.js';
import type { CommandKey, JsonValue } from './ports.js';
import type {
  ActivateOffer,
  ComposerSession,
  NavigationCommand,
  NavigationPorts,
  NavigationResult,
  ReadExposureContext,
  StoredOffer,
} from './navigation-ports.js';
const OFFER_TTL_MS = 15 * 60000;
const ref = (r: EncounterRef): EncounterRef => ({ assetId: r.assetId, assetRevision: r.assetRevision });
const same = (a: EncounterRef, b: EncounterRef) => a.assetId === b.assetId && a.assetRevision === b.assetRevision;
const json = (value: unknown): { readonly [key: string]: JsonValue } =>
  JSON.parse(JSON.stringify(value)) as { readonly [key: string]: JsonValue };
const refuse = (code: ProblemCode): NavigationResult => ({ kind: 'refused', code });
const scopeCode = (kind: string): ProblemCode =>
  kind === 'epoch_changed' ? 'PRIVACY_EPOCH_CHANGED' : 'UNIVERSE_UNAVAILABLE';
function keyOf(p: NavigationPorts, command: NavigationCommand): CommandKey {
  const { commandId, ...request } = command;
  const operation = 'intent' in command ? 'experience.navigate-v0' : 'experience.compose-open-v0';
  return { commandId, operation, requestHash: p.hashRequest(operation, json(request)), outcomeVersion: 1 };
}
// The private receipt holds only immutable result identity; public metadata lives in the same
// atomically committed scoped offer rows. This keeps the existing whole-receipt8KiB constraint.
const ReceiptCommon = {
  version: z.literal('navigation-receipt.v0'),
  commandId: z.uuid(),
  sessionId: z.uuid(),
  intentRevision: z.number().int().min(0),
  revision: z.number().int().min(0),
  decisionId: z.uuid(),
  replayed: z.literal(false),
};
const NavigationReceipt = z.discriminatedUnion('status', [
  z.strictObject({
    ...ReceiptCommon,
    status: z.literal('ready'),
    offerId: z.uuid(),
    bufferedOfferIds: z.array(z.uuid()).max(2),
  }),
  z.strictObject({
    ...ReceiptCommon,
    status: z.literal('exhausted'),
    reason: z.enum([
      'no_eligible_content',
      'series_boundary',
      'no_related_ready',
      'variant_unavailable',
      'return_unavailable',
    ]),
  }),
]);
async function receipt(
  p: NavigationPorts,
  scope: PersonalScopeTx,
  key: CommandKey,
): Promise<NavigationResult | undefined> {
  const r = await p.findReceipt(scope, key);
  if (r.kind === 'new') return undefined;
  if (r.kind !== 'replay')
    return refuse(r.kind === 'outcome_version_newer' ? 'SERVICE_UNAVAILABLE' : 'COMMAND_KEY_REUSED');
  const stored = NavigationReceipt.safeParse(r.outcome);
  if (!stored.success) return refuse('SERVICE_UNAVAILABLE');
  const { version: _version, ...value } = stored.data;
  if (value.status === 'exhausted')
    return { kind: 'accepted', outcome: NavigationOutcomeSchema.parse({ ...value, replayed: true }) };
  const ids = [value.offerId, ...value.bufferedOfferIds];
  const offers = await p.readOwnedOffers(scope, ids);
  if (
    offers.length !== ids.length ||
    offers.some(
      (o, i) =>
        o.id !== ids[i] ||
        o.sessionId !== value.sessionId ||
        o.intentRevision !== value.intentRevision ||
        o.descriptor.decisionId !== value.decisionId,
    )
  )
    return refuse('SERVICE_UNAVAILABLE');
  const { offerId: _offerId, bufferedOfferIds: _bufferedOfferIds, ...common } = value;
  return {
    kind: 'accepted',
    outcome: NavigationOutcomeSchema.parse({
      ...common,
      replayed: true,
      offer: offers[0]!.descriptor,
      bufferedOffers: offers.slice(1).map((o) => o.descriptor),
    }),
  };
}
interface Prepared {
  readonly kind: 'prepared';
  readonly session: ComposerSession;
  readonly creates: boolean;
  readonly source?: { readonly offerId: string; readonly exposureId: string };
  readonly mode: StoredOffer['mode'];
  readonly links: readonly ContinuityLink[];
  readonly snapshot: ComposerSnapshot;
  readonly reason: Extract<NavigationOutcome, { status: 'exhausted' }>['reason'];
  readonly decisionId: string;
  readonly now: Date;
}
async function prepare(
  p: NavigationPorts,
  scope: PersonalScopeTx,
  c: NavigationCommand,
  key: CommandKey,
): Promise<Prepared | NavigationResult> {
  const old = await receipt(p, scope, key);
  if (old) return old;
  const isNav = 'intent' in c;
  const sessionRef = isNav ? { sessionId: c.sessionId, expectedIntentRevision: c.expectedIntentRevision } : c.session;
  const existing = sessionRef ? await p.readSession(scope, sessionRef.sessionId) : undefined;
  if (sessionRef && !existing) return refuse('NOT_FOUND');
  if (existing && existing.intentRevision !== sessionRef!.expectedIntentRevision)
    return refuse('INTENT_REVISION_STALE');
  const capabilities = isNav ? existing!.capabilities : c.capabilities;
  const parsed = ClientCapabilities.safeParse(capabilities);
  if (!parsed.success) return refuse('UNPROCESSABLE_REQUEST');
  const formats = (['reel', 'scroll'] as const).filter((f) => parsed.data.documentSchemas.includes(`${f}-document.v1`));
  const mode: StoredOffer['mode'] = isNav ? c.intent.mode : c.target.kind === 'return' ? 'return' : 'vertical';
  const now = p.now();
  const session: ComposerSession = {
    id: existing?.id ?? p.newId(),
    privacyEpoch: scope.authority.privacyEpoch,
    intentRevision: existing ? existing.intentRevision + 1 : 0,
    capabilities: json(capabilities),
  };
  let source: Prepared['source'];
  let sourceContent: EncounterSnapshot | undefined;
  if (isNav) {
    const member = await p.readMember(scope, c.sessionId, c.from.offerId, c.from.exposureId);
    if (!member) return refuse('OFFER_UNAVAILABLE');
    sourceContent = await p.readExactEncounter(scope, { ...ref(member.offer.descriptor), capabilities });
    if (!sourceContent) return refuse('OFFER_UNAVAILABLE');
    source = { ...c.from };
  }
  let candidates: readonly EncounterSnapshot[] = [];
  let links: readonly ContinuityLink[] = [];
  let reason: Prepared['reason'] = 'no_eligible_content';
  let exact: EncounterRef | undefined;
  if (mode === 'vertical') {
    if (formats.length)
      candidates = await p.readDiscoveryCandidates(scope, {
        languages: [sourceContent?.metadata.language ?? 'en'],
        formats,
        capabilities,
        topicIds: sourceContent?.topics.filter((t) => t.role !== 'incidental').map((t) => t.topicId) ?? [],
        limit: 100,
      });
  } else if (mode === 'return') {
    exact =
      isNav && c.intent.mode === 'return'
        ? ref(c.intent.target)
        : !isNav && c.target.kind === 'return'
          ? ref(c.target)
          : undefined;
    reason = 'return_unavailable';
    if (exact) {
      const candidate = await p.readExactEncounter(scope, { ...exact, capabilities });
      if (candidate) candidates = [candidate];
    }
  } else if (mode === 'variant' && isNav && c.intent.mode === 'variant') {
    reason = 'variant_unavailable';
    const format = c.intent.to;
    exact = sourceContent?.siblings.find((s) => s.kind === format);
    if (exact) {
      exact = ref(exact);
      const candidate = await p.readExactEncounter(scope, { ...exact, capabilities });
      if (candidate && candidate.explanationUnitId === sourceContent!.explanationUnitId) candidates = [candidate];
    }
  } else if ((mode === 'series' || mode === 'related') && sourceContent && isNav) {
    const direction = c.intent.mode === 'series' ? c.intent.direction : 'related';
    reason = mode === 'series' ? 'series_boundary' : 'no_related_ready';
    const all = await p.readContinuations(scope, ref(sourceContent));
    const expected =
      c.intent.mode === 'series' || c.intent.mode === 'related' ? c.intent.expectedContinuation : undefined;
    const link = all.find(
      (l) => l.direction === direction && (!expected || (l.linkId === expected.linkId && same(l.target, expected))),
    );
    if (expected && !link) return refuse('OFFER_UNAVAILABLE');
    if (link) {
      links = [link];
      exact = ref(link.target);
      const candidate = await p.readExactEncounter(scope, { ...exact, capabilities });
      if (candidate) candidates = [candidate];
    }
  }
  const assetIds = [...new Set(candidates.map((x) => x.assetId))];
  const hidden = await p.readHidden(scope, assetIds);
  const topicIds = [...new Set(candidates.flatMap((x) => x.topics.map((t) => t.topicId)))].slice(0, 100);
  const units = [...new Set(candidates.map((x) => x.explanationUnitId))].map((explanationUnitId) => ({
    explanationUnitId,
    facets: [
      ...new Set(candidates.filter((x) => x.explanationUnitId === explanationUnitId).flatMap((x) => x.facets)),
    ].slice(0, 16),
  }));
  const evidence = await p.readPrepared(scope, {
    evaluatedAt: now.toISOString(),
    topicIds,
    candidates: units,
    candidateAssetIds: assetIds,
  });
  let snapshot: ComposerSnapshot = {
    universeId: scope.authority.universeId,
    privacyEpoch: scope.authority.privacyEpoch,
    evaluatedAt: now.toISOString(),
    seed: c.commandId,
    mode: mode === 'series' || mode === 'related' ? 'horizontal' : mode,
    intent: {
      language: candidates[0]?.metadata.language ?? sourceContent?.metadata.language ?? 'en',
      topicIds: sourceContent?.topics.filter((t) => t.role !== 'incidental').map((t) => t.topicId) ?? [],
      text: sourceContent ? `${sourceContent.metadata.title} ${sourceContent.metadata.summary}`.slice(0, 2000) : '',
      ...(exact ? { exactTarget: ref(exact) } : {}),
      ...(mode === 'variant' && isNav && c.intent.mode === 'variant'
        ? { format: c.intent.to, explanationUnitId: sourceContent!.explanationUnitId }
        : {}),
      ...(links[0] ? { continuityLinkId: links[0].linkId } : {}),
    },
    ...(sourceContent ? { source: ref(sourceContent) } : {}),
    candidates: candidates.map((encounter) => {
      const link = links.find((l) => same(l.target, encounter));
      return {
        encounter,
        admitted: true,
        accessible: !hidden.includes(encounter.assetId),
        renderable: true,
        ...(link
          ? {
              continuity: {
                linkId: link.linkId,
                source: ref(link.source),
                target: ref(link.target),
                direction: link.direction,
                strength: link.strength,
              },
            }
          : {}),
      };
    }),
    explorationPool: mode === 'vertical' ? candidates.map(ref) : [],
    ...(evidence ? { evidence } : {}),
    watermarks: {
      catalog: p.hashRequest(
        'content-candidate-watermarks',
        candidates.map((x) => x.catalogWatermark),
      ),
      continuity: links.map((l) => `${l.linkId}:${String(l.revision)}`).join(':') || 'none',
      taxonomy: 'admitted-brief-taxonomy.v0',
      context: evidence?.watermark ?? `unprepared:${String(scope.revisionAtEntry)}`,
    },
  };
  // Keep the complete private decision under its durable byte bound, without inventing context.
  // Retrieval stays<=100; budget truncation is deterministic and reduces only the scoring pool.
  for (let budget = 0; budget < 100 && new TextEncoder().encode(JSON.stringify(snapshot)).length > 180000; budget++) {
    const rows = snapshot.candidates.slice(0, -1);
    const units = new Set(rows.map((c) => c.encounter.explanationUnitId));
    const topics = new Set(rows.flatMap((c) => c.encounter.topics.map((t) => t.topicId)));
    const assets = new Set(rows.map((c) => c.encounter.assetId));
    const prior = snapshot.evidence;
    const nextEvidence = prior
      ? {
          ...prior,
          topics: prior.topics.filter((t) => topics.has(t.topicId)),
          hiddenAssetIds: prior.hiddenAssetIds.filter((id) => assets.has(id)),
          ...(prior.established
            ? {
                established: {
                  ...prior.established,
                  units: prior.established.units
                    .filter((u) => units.has(u.explanationUnitId))
                    .map((u) => {
                      const facets = new Set(
                        rows
                          .filter((c) => c.encounter.explanationUnitId === u.explanationUnitId)
                          .flatMap((c) => c.encounter.facets),
                      );
                      return { ...u, facets: u.facets.filter((f) => facets.has(f.facetId)) };
                    }),
                },
              }
            : {}),
        }
      : undefined;
    snapshot = {
      ...snapshot,
      candidates: rows,
      explorationPool: mode === 'vertical' ? rows.map((c) => ref(c.encounter)) : [],
      ...(nextEvidence ? { evidence: nextEvidence } : {}),
      watermarks: {
        ...snapshot.watermarks,
        catalog: p.hashRequest(
          'content-candidate-watermarks',
          rows.map((c) => c.encounter.catalogWatermark),
        ),
      },
    };
  }
  return {
    kind: 'prepared',
    session,
    creates: !existing,
    ...(source ? { source } : {}),
    mode,
    links,
    snapshot,
    reason,
    decisionId: p.newId(),
    now,
  };
}
async function variants(
  p: NavigationPorts,
  scope: PersonalScopeTx,
  c: EncounterSnapshot,
  capabilities: unknown,
): Promise<EncounterOffer['variants']> {
  const out: EncounterOffer['variants'] = [];
  for (const kind of ['reel', 'scroll'] as const) {
    if (kind === c.kind) {
      out.push({ status: 'ready', kind, ...ref(c) });
      continue;
    }
    const sibling = c.siblings.find((s) => s.kind === kind);
    const exact = sibling ? await p.readExactEncounter(scope, { ...ref(sibling), capabilities }) : undefined;
    const hidden = exact ? await p.readHidden(scope, [exact.assetId]) : [];
    out.push(exact && !hidden.length ? { status: 'ready', kind, ...ref(exact) } : { status: 'unavailable', kind });
  }
  return out;
}
/** Two short scope transactions, pure Composer outside them, at most one bounded drift rerank. */
export function makeNavigateEncounter(p: NavigationPorts) {
  return async (authority: PersonalAuthority, c: NavigationCommand): Promise<NavigationResult> => {
    const key = keyOf(p, c);
    for (let attempt = 0; attempt < 2; attempt++) {
      const entry = await p.withPersonalScope(authority, (s) => prepare(p, s, c, key));
      if (entry.kind !== 'entered') return refuse(scopeCode(entry.refusal.kind));
      const prepared = entry.value;
      if (prepared.kind !== 'prepared') return prepared;
      const decision = p.compose(prepared.snapshot);
      const commit = await p.withPersonalScope(
        authority,
        async (scope): Promise<NavigationResult | { kind: 'drift' }> => {
          const old = await receipt(p, scope, key);
          if (old) return old;
          const latest = await p.readSession(scope, prepared.session.id);
          if (prepared.creates ? latest !== undefined : latest?.intentRevision !== prepared.session.intentRevision - 1)
            return refuse('INTENT_REVISION_STALE');
          if (prepared.source) {
            const member = await p.readMember(
              scope,
              prepared.session.id,
              prepared.source.offerId,
              prepared.source.exposureId,
            );
            if (
              !member ||
              !(await p.readExactEncounter(scope, {
                ...ref(member.offer.descriptor),
                capabilities: prepared.session.capabilities,
              }))
            )
              return refuse('OFFER_UNAVAILABLE');
          }
          const selected: EncounterSnapshot[] = [];
          for (const target of decision.selection) {
            const exact = await p.readExactEncounter(scope, {
              ...ref(target),
              capabilities: prepared.session.capabilities,
            });
            const original = prepared.snapshot.candidates.find((x) => same(x.encounter, target))!.encounter;
            if (
              !exact ||
              exact.catalogWatermark !== original.catalogWatermark ||
              (await p.readHidden(scope, [target.assetId])).length
            )
              return { kind: 'drift' };
            const link = prepared.links.find((l) => same(l.target, target));
            if (
              link &&
              !(await p.resolveContinuityLink(scope, {
                linkId: link.linkId,
                revision: link.revision,
                source: ref(link.source),
                target: ref(link.target),
              }))
            )
              return { kind: 'drift' };
            selected.push(exact);
          }
          const offers: StoredOffer[] = [];
          for (const target of selected) {
            const id = p.newId();
            const link = prepared.links.find((l) => same(l.target, target));
            const relation: EncounterOffer['relation'] = link
              ? link.relation
              : prepared.mode === 'variant'
                ? { kind: 'format_variant' }
                : prepared.mode === 'return'
                  ? { kind: 'return' }
                  : { kind: 'discovery' };
            offers.push({
              policyVersion: 'offer.v0',
              id,
              sessionId: prepared.session.id,
              intentRevision: prepared.session.intentRevision,
              privacyEpoch: scope.authority.privacyEpoch,
              mode: prepared.mode,
              descriptor: {
                offerId: id,
                decisionId: prepared.decisionId,
                ...ref(target),
                explanationUnitId: target.explanationUnitId,
                metadata: { ...target.metadata },
                relation,
                variants: await variants(p, scope, target, prepared.session.capabilities),
              },
              ...(prepared.source ? { source: prepared.source } : {}),
              ...(link ? { link: { linkId: link.linkId, revision: link.revision } } : {}),
              expiresAt: new Date(prepared.now.getTime() + OFFER_TTL_MS).toISOString(),
            });
          }
          await p.insertReceipt(scope, key);
          await p.writeSession(scope, prepared.session, json('intent' in c ? c.intent : c.target), prepared.creates);
          await p.persistDecision(
            scope,
            {
              decisionId: prepared.decisionId,
              commandId: c.commandId,
              sessionId: prepared.session.id,
              intentRevision: prepared.session.intentRevision,
            },
            decision,
          );
          await p.insertOffers(scope, offers);
          const revision = await p.advanceRevision(scope);
          const common = {
            commandId: c.commandId,
            sessionId: prepared.session.id,
            intentRevision: prepared.session.intentRevision,
            revision,
            decisionId: prepared.decisionId,
            replayed: false,
          };
          const outcome: NavigationOutcome = offers[0]
            ? {
                ...common,
                status: 'ready',
                offer: offers[0].descriptor,
                bufferedOffers: offers.slice(1).map((o) => o.descriptor),
              }
            : { ...common, status: 'exhausted', reason: prepared.reason };
          await p.completeReceipt(
            scope,
            c.commandId,
            json({
              ...common,
              version: 'navigation-receipt.v0',
              ...(outcome.status === 'ready'
                ? {
                    status: 'ready',
                    offerId: outcome.offer.offerId,
                    bufferedOfferIds: outcome.bufferedOffers.map((o) => o.offerId),
                  }
                : { status: 'exhausted', reason: outcome.reason }),
            }),
          );
          await p.notify(scope, { revision, eventId: prepared.decisionId });
          return { kind: 'accepted', outcome };
        },
      );
      if (commit.kind !== 'entered') return refuse(scopeCode(commit.refusal.kind));
      if (commit.value.kind !== 'drift') return commit.value;
    }
    return refuse('OFFER_UNAVAILABLE');
  };
}
export function makeActivateOffer(p: NavigationPorts): ActivateOffer {
  return async (authority, c) => {
    const operation = 'experience.activate-offer-v0';
    const key = {
      commandId: c.commandId,
      operation,
      requestHash: p.hashRequest(operation, json(c.target)),
      outcomeVersion: 1,
    };
    const entered = await p.withPersonalScope(authority, async (scope) => {
      const lookup = await p.findReceipt(scope, key);
      if (lookup.kind !== 'new' && lookup.kind !== 'replay')
        return {
          kind: 'refused' as const,
          code:
            lookup.kind === 'outcome_version_newer'
              ? ('SERVICE_UNAVAILABLE' as const)
              : ('COMMAND_KEY_REUSED' as const),
        };
      const session = await p.readSession(scope, c.target.sessionId);
      const offer = await p.readOffer(scope, c.target.offerId);
      if (!session || !offer || offer.sessionId !== session.id)
        return { kind: 'refused' as const, code: 'OFFER_UNAVAILABLE' as const };
      const exact = await p.readExactEncounter(scope, { ...ref(offer.descriptor), capabilities: session.capabilities });
      if (!exact) return { kind: 'refused' as const, code: 'OFFER_UNAVAILABLE' as const };
      if (lookup.kind === 'replay')
        return {
          kind: 'accepted' as const,
          outcome: { ...ActivateOfferResponseSchema.parse(lookup.outcome), replayed: true },
        };
      if ((await p.readHidden(scope, [exact.assetId])).length)
        return { kind: 'refused' as const, code: 'OFFER_UNAVAILABLE' as const };
      if (session.intentRevision !== c.target.expectedIntentRevision || offer.intentRevision !== session.intentRevision)
        return { kind: 'refused' as const, code: 'INTENT_REVISION_STALE' as const };
      if (Date.parse(offer.expiresAt) <= p.now().getTime())
        return { kind: 'refused' as const, code: 'OFFER_UNAVAILABLE' as const };
      if (offer.source) {
        const member = await p.readMember(scope, session.id, offer.source.offerId, offer.source.exposureId);
        if (
          !member ||
          !(await p.readExactEncounter(scope, { ...ref(member.offer.descriptor), capabilities: session.capabilities }))
        )
          return { kind: 'refused' as const, code: 'OFFER_UNAVAILABLE' as const };
        if (
          offer.link &&
          !(await p.resolveContinuityLink(scope, {
            linkId: offer.link.linkId,
            revision: offer.link.revision,
            source: ref(member.offer.descriptor),
            target: ref(offer.descriptor),
          }))
        )
          return { kind: 'refused' as const, code: 'OFFER_UNAVAILABLE' as const };
      }
      const bound = await p.readMember(scope, session.id, offer.id);
      let exposureId = bound?.exposureId;
      let activatedAt = bound?.activatedAt;
      await p.insertReceipt(scope, key);
      if (!exposureId) {
        exposureId = p.newId();
        const now = p.now();
        await p.insertExposure(scope, {
          id: exposureId,
          ...ref(exact),
          kind: exact.kind,
          origin: 'composer',
          capabilities: session.capabilities,
          commandId: c.commandId,
          openedAt: now,
        });
        await p.markActivated(scope, exposureId, now);
        await p.bindOffer(scope, offer.id, exposureId);
        const metadata = await p.readAttribution(scope, ref(exact));
        if (metadata) await p.recordActivation(scope, exposureId, metadata, offer);
        await p.enqueueActivity(scope, exposureId);
        if (offer.source && (offer.mode === 'series' || offer.mode === 'related'))
          await p.enqueueActivity(scope, offer.source.exposureId);
        activatedAt = now.toISOString();
      }
      const revision = bound ? scope.revisionAtEntry : await p.advanceRevision(scope);
      const outcome = ActivateOfferResponseSchema.parse({
        commandId: c.commandId,
        sessionId: session.id,
        offerId: offer.id,
        intentRevision: offer.intentRevision,
        exposureId,
        ...ref(exact),
        kind: exact.kind,
        activatedAt,
        revision,
        replayed: false,
      });
      await p.completeReceipt(scope, c.commandId, json(outcome));
      if (!bound) await p.notify(scope, { revision, eventId: exposureId });
      return { kind: 'accepted' as const, outcome };
    });
    return entered.kind === 'entered' ? entered.value : { kind: 'refused', code: scopeCode(entered.refusal.kind) };
  };
}
export function makeReadExposureContext(p: NavigationPorts): ReadExposureContext {
  return async (authority, id) => {
    const entered = await p.withPersonalScope(authority, async (scope) => {
      const base = await p.readContextBase(scope, id);
      if (!base) return { kind: 'refused' as const, code: 'NOT_FOUND' as const };
      const exact = await p.readExactEncounter(scope, { ...base.ref, capabilities: base.capabilities });
      if (!exact) return { kind: 'refused' as const, code: 'ASSET_NOT_FOUND' as const };
      const continuations: ExposureContextResponse['continuations'] = {
        seriesPrevious: { status: 'unavailable', reason: 'series_boundary' },
        seriesNext: { status: 'unavailable', reason: 'series_boundary' },
        related: { status: 'unavailable', reason: 'no_related_ready' },
      };
      for (const link of await p.readContinuations(scope, base.ref)) {
        const target = await p.readExactEncounter(scope, { ...ref(link.target), capabilities: base.capabilities });
        if (!target || (await p.readHidden(scope, [target.assetId])).length) continue;
        const slot =
          link.direction === 'previous' ? 'seriesPrevious' : link.direction === 'next' ? 'seriesNext' : 'related';
        continuations[slot] = {
          status: 'ready',
          linkId: link.linkId,
          target: ref(target),
          metadata: { ...target.metadata },
          relation: link.relation,
        };
      }
      return {
        kind: 'read' as const,
        context: {
          exposureId: id,
          ...base.ref,
          revision: scope.revisionAtEntry,
          ...(base.session ? { session: base.session } : {}),
          actions: base.actions,
          ...(exact.series ? { series: exact.series } : {}),
          variants: await variants(p, scope, exact, base.capabilities),
          continuations,
        },
      };
    });
    return entered.kind === 'entered' ? entered.value : { kind: 'refused', code: scopeCode(entered.refusal.kind) };
  };
}
