import {
  ActivateOfferResponseSchema,
  type EncounterOffer,
  type ExposureContextResponse,
  type NavigationOutcome,
} from '@knowscroll/contracts';
import type { BufferedSelection, ComposerDecision } from '../../composer/public.js';
import type { EncounterSnapshot } from '../../content/public.js';
import type { PersonalAuthority, PersonalScopeTx } from '../../identity/public.js';
import { originalRecordingGeneration, recordingRequest, type CommandKey } from './ports.js';
import type {
  ActivateOffer,
  NavigationCommand,
  NavigationPorts,
  NavigationResult,
  ReadExposureContext,
  StoredOffer,
  RegionActivationPermit,
} from './navigation-ports.js';
import { OfferRegionConstraintSchema } from './navigation-ports.js';
import { keyOf, receipt } from './navigation-receipt.js';
import { prepare, type Prepared } from './navigation-prepare.js';
import {
  currentRegionOffers,
  isRegionOpen,
  json,
  ref,
  refuse,
  same,
  sameRegion,
  scopeCode,
} from './navigation-support.js';

const OFFER_TTL_MS = 15 * 60000;
const regionPermits = new WeakMap<
  RegionActivationPermit,
  { readonly scope: PersonalScopeTx; readonly offerId: string }
>();
function issueRegionPermit(scope: PersonalScopeTx, offerId: string): RegionActivationPermit {
  const permit = Object.freeze({}) as RegionActivationPermit;
  regionPermits.set(permit, { scope, offerId });
  return permit;
}
/** Adapter-only consumption. It must first verify the actual transaction is still open. */
export function consumeRegionActivationPermit(
  scope: PersonalScopeTx,
  offerId: string,
  permit: RegionActivationPermit,
): boolean {
  const binding = regionPermits.get(permit);
  if (!binding || binding.scope !== scope || binding.offerId !== offerId) return false;
  regionPermits.delete(permit);
  return true;
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

/** The offers a navigation will commit, in order, with the content watermark each was ranked at. */
interface Ranked {
  readonly selection: readonly BufferedSelection[];
  /** Present when ranked now; absent when a worker already ranked and stored the decision. */
  readonly decision?: ComposerDecision;
}

/** Ranks outside any transaction (blueprint §7), or takes the worker's stored ranking. */
function rankPrepared(p: NavigationPorts, prepared: Prepared): Ranked {
  if (prepared.ranking.kind === 'buffered') return { selection: prepared.ranking.buffer.selection };
  const { snapshot } = prepared.ranking;
  const decision = p.compose(snapshot);
  const selection = decision.selection.map((selected) => ({
    ...ref(selected),
    catalogWatermark: snapshot.candidates.find((c) => same(c.encounter, selected))!.encounter.catalogWatermark,
  }));
  return { decision, selection };
}

interface CommitContext {
  readonly command: NavigationCommand;
  readonly key: CommandKey;
  readonly prepared: Prepared;
  readonly ranked: Ranked;
  /** The recording generation of the first attempt: a rerank cannot upgrade it after a policy transition. */
  readonly firstEligibility: number | null;
}
type Drift = { readonly kind: 'drift' };

/** Two short scope transactions, pure Composer outside them, at most one bounded drift rerank. */
export function makeNavigateEncounter(p: NavigationPorts) {
  return async (authority: PersonalAuthority, command: NavigationCommand): Promise<NavigationResult> => {
    const key = keyOf(p, command);
    let firstEligibility: number | null | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const entry = await p.withPersonalScope(authority, (scope) => prepare(p, scope, command, key));
      if (entry.kind !== 'entered') return refuse(scopeCode(entry.refusal.kind));
      const prepared = entry.value;
      if (prepared.kind !== 'prepared') return prepared;
      if (firstEligibility === undefined) firstEligibility = prepared.recordingGeneration ?? null;
      const original = firstEligibility;
      const ranked = rankPrepared(p, prepared);
      const commit = await p.withPersonalScope(authority, (scope) =>
        commitNavigation(p, scope, { command, key, prepared, ranked, firstEligibility: original }),
      );
      if (commit.kind !== 'entered') return refuse(scopeCode(commit.refusal.kind));
      if (commit.value.kind !== 'drift') return commit.value;
    }
    return refuse('OFFER_UNAVAILABLE');
  };
}

/**
 * Transaction 2 (blueprint §7): under the personal lock, recheck everything transaction 1 relied
 * on, then insert the receipt before any effect and commit session intent, offers, decision and
 * any job together. `drift` means the candidates changed and one bounded rerank is allowed.
 */
async function commitNavigation(
  p: NavigationPorts,
  scope: PersonalScopeTx,
  context: CommitContext,
): Promise<NavigationResult | Drift> {
  const stale = await recheckPreparation(p, scope, context);
  if (stale) return stale;
  const regionLock = await lockRegionSelection(p, scope, context);
  if (regionLock) return regionLock.kind === 'drift' ? discardBuffer(p, scope, context) : regionLock;
  const selected = await selectStillEligible(p, scope, context);
  if (!selected) return discardBuffer(p, scope, context);
  const offers = await buildOffers(p, scope, context, selected);
  return writeOutcome(p, scope, context, offers);
}

/** A drifted buffer is never served: it goes, with its decision, and the rerank ranks for itself. */
async function discardBuffer(p: NavigationPorts, scope: PersonalScopeTx, context: CommitContext): Promise<Drift> {
  if (context.prepared.ranking.kind === 'buffered')
    await p.buffers?.release(scope, context.prepared.decisionId, 'discarded');
  return { kind: 'drift' };
}

/** The checks that hold the result of transaction 1 to the state now under the lock. */
async function recheckPreparation(
  p: NavigationPorts,
  scope: PersonalScopeTx,
  { command, key, prepared }: CommitContext,
): Promise<NavigationResult | undefined> {
  if (prepared.region) {
    const live = await p.readRegionConstraint(scope, prepared.region.constraint.target);
    if (live.kind !== 'read' || !sameRegion(p, live.constraint, prepared.region.constraint))
      return refuse('OFFER_UNAVAILABLE');
  }
  const replay = await receipt(p, scope, key, isRegionOpen(command) ? command.capabilities : undefined);
  if (replay) return replay;
  const latest = await p.readSession(scope, prepared.session.id);
  if (prepared.creates ? latest !== undefined : latest?.intentRevision !== prepared.session.intentRevision - 1)
    return refuse('INTENT_REVISION_STALE');
  if (prepared.source) {
    const member = await p.readMember(scope, prepared.session.id, prepared.source.offerId, prepared.source.exposureId);
    const exact = member
      ? await p.readExactEncounter(scope, {
          ...ref(member.offer.descriptor),
          capabilities: prepared.session.capabilities,
        })
      : undefined;
    if (!exact) return refuse('OFFER_UNAVAILABLE');
  }
  return undefined;
}

/** For a regional move: the selection must still be exactly the region's covered candidates. */
async function lockRegionSelection(
  p: NavigationPorts,
  scope: PersonalScopeTx,
  { command, prepared, ranked }: CommitContext,
): Promise<NavigationResult | Drift | undefined> {
  const { region } = prepared;
  if (!region) return undefined;
  if (!ranked.selection.length && (region.hasMore || (isRegionOpen(command) && command.expectedEncounter)))
    return refuse('OFFER_UNAVAILABLE');
  const captured = ranked.selection.map((target) => region.candidates.find((x) => same(x.encounter, target)));
  if (captured.some((x) => !x)) throw new Error('REGION_SELECTION_INVALID');
  const locked = await p.lockRegionCandidates(scope, {
    topicId: region.constraint.topicId,
    facetId: region.constraint.facetId,
    truthStatus: region.constraint.truthStatus,
    capabilities: prepared.session.capabilities,
    candidates: captured.map((x) => ({ ref: ref(x!.encounter), coverage: x!.coverage })),
  });
  return locked ? undefined : { kind: 'drift' };
}

/** Rereads each ranked candidate: still admitted, same content, not hidden, link still current. `undefined` is drift. */
async function selectStillEligible(
  p: NavigationPorts,
  scope: PersonalScopeTx,
  { prepared, ranked }: CommitContext,
): Promise<EncounterSnapshot[] | undefined> {
  const selected: EncounterSnapshot[] = [];
  for (const target of ranked.selection) {
    const exact = await p.readExactEncounter(scope, { ...ref(target), capabilities: prepared.session.capabilities });
    if (
      !exact ||
      exact.catalogWatermark !== target.catalogWatermark ||
      (await p.readHidden(scope, [target.assetId])).length
    )
      return undefined;
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
      return undefined;
    selected.push(exact);
  }
  return selected;
}

async function buildOffers(
  p: NavigationPorts,
  scope: PersonalScopeTx,
  { prepared }: CommitContext,
  selected: readonly EncounterSnapshot[],
): Promise<StoredOffer[]> {
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
      ...(prepared.region
        ? {
            regionConstraint: OfferRegionConstraintSchema.parse({
              version: 'offer-region-constraint.v1',
              region: prepared.region.constraint,
              coverage: prepared.region.candidates.find((x) => same(x.encounter, target))!.coverage,
            }),
          }
        : {}),
    });
  }
  return offers;
}

/** The receipt, session, decision, offers, recording provenance, revision and hint, all in this transaction. */
async function writeOutcome(
  p: NavigationPorts,
  scope: PersonalScopeTx,
  { command, key, prepared, ranked, firstEligibility }: CommitContext,
  offers: readonly StoredOffer[],
): Promise<NavigationResult> {
  const recording = await p.recording?.fence(scope, originalRecordingGeneration(command));
  if (recording?.kind === 'unavailable') return refuse('SERVICE_UNAVAILABLE');
  const eligible =
    recording?.kind === 'recording' &&
    recording.scope.generation === prepared.recordingGeneration &&
    recording.scope.generation === firstEligibility
      ? recording.scope.generation
      : undefined;
  await p.insertReceipt(scope, key);
  await p.recording?.remember(scope, key, originalRecordingGeneration(command), eligible, p.now());
  await p.writeSession(
    scope,
    prepared.session,
    json('intent' in command ? command.intent : command.target),
    prepared.creates,
  );
  if (ranked.decision)
    await p.persistDecision(
      scope,
      {
        decisionId: prepared.decisionId,
        commandId: command.commandId,
        sessionId: prepared.session.id,
        intentRevision: prepared.session.intentRevision,
      },
      ranked.decision,
    );
  await p.insertOffers(scope, offers);
  // The offers now reference the stored decision, so a served buffer is only its row.
  if (prepared.ranking.kind === 'buffered') await p.buffers?.release(scope, prepared.decisionId, 'served');
  await p.recording?.bindOfferOrigins(
    scope,
    offers.map((o) => o.id),
    command.commandId,
    eligible,
  );
  const revision = await p.advanceRevision(scope);
  const common = {
    commandId: command.commandId,
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
    command.commandId,
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
}

export function makeActivateOffer(p: NavigationPorts): ActivateOffer {
  return async (authority, c) => {
    const operation = 'experience.activate-offer-v0';
    const key = {
      commandId: c.commandId,
      operation,
      requestHash: p.hashRequest(operation, json({ ...c.target, ...recordingRequest(c) })),
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
      if (offer.regionConstraint && !(await currentRegionOffers(p, scope, [offer], session.capabilities)))
        return { kind: 'refused' as const, code: 'OFFER_UNAVAILABLE' as const };
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
      const at = p.now();
      const recording = await p.recording?.fence(scope, originalRecordingGeneration(c));
      if (recording?.kind === 'unavailable') return { kind: 'refused' as const, code: 'SERVICE_UNAVAILABLE' as const };
      await p.insertReceipt(scope, key);
      await p.recording?.remember(
        scope,
        key,
        originalRecordingGeneration(c),
        recording?.kind === 'recording' ? recording.scope.generation : undefined,
        at,
      );
      if (!exposureId) {
        exposureId = p.newId();
        const now = at;
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
        await p.bindOffer(
          scope,
          offer.id,
          exposureId,
          offer.regionConstraint ? issueRegionPermit(scope, offer.id) : undefined,
        );
        const metadata = await p.readAttribution(scope, ref(exact));
        if (metadata) await p.recordActivation(scope, exposureId, metadata, offer, originalRecordingGeneration(c));
        await p.enqueueActivity(scope, exposureId, originalRecordingGeneration(c));
        if (offer.source && (offer.mode === 'series' || offer.mode === 'related'))
          await p.enqueueActivity(scope, offer.source.exposureId, originalRecordingGeneration(c));
        // The person is now on this offer, so the next subject move from it can be prepared ahead.
        // A regional offer's next move inherits its region and is ranked on request instead.
        if (!offer.regionConstraint)
          await p.buffers?.requestPreparation(scope, {
            sessionId: session.id,
            intentRevision: offer.intentRevision,
            source: { offerId: offer.id, exposureId },
          });
        activatedAt = now.toISOString();
      }
      const offerGeneration = await p.recording?.offerOrigin(scope, offer.id);
      if (recording?.kind === 'recording')
        await p.recording?.activation(recording.scope, exposureId, c.commandId, at, {
          fresh: !bound,
          mode: offer.mode,
          ...(offer.source ? { source: offer.source.exposureId } : {}),
          ...(offerGeneration === undefined ? {} : { eligibleGeneration: offerGeneration }),
        });
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
