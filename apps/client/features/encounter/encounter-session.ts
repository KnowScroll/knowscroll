import { CancelledError } from '@tanstack/react-query';
import {
  apiProblem,
  recordingCommandFields,
  freezeRecordingCommand,
  createReelRecorder,
  createScrollRecorder,
  feedbackFor,
  parseScrollDocument,
  ScopeEndedError,
  type AccountScope,
  type AvailableRegionPreview,
  type KeepPlaceHandle,
  type KeepPlaceState,
} from '@knowscroll/client-core';
import {
  ActivateOfferResponseSchema,
  RegionEncounterOpenRequestSchema,
  RegionEncounterOpenResponseSchema,
  RegionEncounterPreviewResponseSchema,
} from '@knowscroll/contracts';
import type {
  ApplyActionRequest,
  ActivateExposureRequest,
  ClientCapabilities,
  EncounterOffer,
  ExposureContextResponse,
  KeepEntryRef,
  NavigateExperienceRequest,
  NavigationOutcome,
  OfferCover,
  CoverPass,
} from '@knowscroll/contracts';
import { afterPendingBack } from '../../platform/after-pending-back';
import type { AnyOpenedScroll } from '../scroll/scroll-session';
import { createRequestSession, type AskAnchor, type RequestMode } from '../requests/request-session';
import { savedRemovalFor, type SavedRemovalState } from '../saved/saved-query';
import type { EncounterGestureMove } from './gestures/arbitration';
import { ENCOUNTER_CAPABILITIES } from './capabilities';
import { createEncounterHistory, readResume, type EncounterEntry } from './encounter-history';
import {
  keepBridgeFor,
  refreshKeep,
  sameKeep,
  keepPositionFor,
  checkpointPosition,
  type AvailableKeep,
} from '../saved/keep-place-bridge';

export type EncounterPhase =
  | 'keep_blocked'
  | 'idle'
  | 'covers'
  | 'opening'
  | 'ready_offer'
  | 'activating'
  | 'active'
  | 'pending'
  | 'exhausted'
  | 'offline'
  | 'error'
  | 'stale'
  | 'revoked';
export interface EncounterState {
  readonly phase: EncounterPhase;
  readonly entry?: EncounterEntry;
  readonly trail: readonly EncounterEntry[];
  readonly outcome?: NavigationOutcome;
  /**
   * E08 "Somewhere new": the offers a discovery returned, waiting for the person to pick one. Nothing
   * is activated until they do, so looking at the choices records nothing.
   */
  readonly choices?: readonly EncounterOffer[];
  /** The hand of Scroll covers on screen (#745), or none. Nothing in it is opened until the person taps a cover. */
  readonly covers?: CoverHand;
  readonly actionPending?: boolean;
  readonly actionFailed?: boolean;
  /** The ready Reel or Scroll the person asked for and opened from its notice; the encounter says so (E07). */
  readonly askedFor?: { readonly assetId: string; readonly kind: 'reel' | 'scroll' };
  readonly overlay: boolean;
  readonly overlayOwner?: 'path' | 'request' | 'share' | 'feedback';
  /** Where the feedback sheet opens: its menu, or straight on a form (a long-press, or a row of ⋯). */
  readonly feedbackStart?: 'menu' | 'content_error' | 'abuse';
  readonly surfaceRevision: number;
  readonly contextReady?: boolean;
  readonly keepPlace?: KeepPlaceState;
  readonly removal?: SavedRemovalState;
}
type Intent = NavigateExperienceRequest['intent'];
type ReadyOutcome = Extract<NavigationOutcome, { status: 'ready' }>;
/** A Scroll offer the server sent with its cover (`offer-cover.v1`). */
export type CoveredOffer = EncounterOffer & { readonly cover: OfferCover };
/**
 * Covers in Explore (#745): the Scroll offers of one outcome, shown one at a time and opened only on a tap. A hand is
 * dealt by the moves the system chooses (a first open, a move to a new subject, more covers); a move the person names
 * (a Part, a related link, a format switch, Keep, a region) opens at once as before.
 */
export interface CoverHand {
  readonly id: string;
  readonly outcome: ReadyOutcome;
  /** The Scroll offers of the outcome that carry a cover, in the server's order. */
  readonly offers: readonly CoveredOffer[];
  /** Which cover is up. */
  readonly index: number;
  /** The entry that was current when the hand was dealt: Back from the covers returns to it. */
  readonly origin?: string;
  /** When the hand arrived, on this device's clock: its offers can be opened for fifteen minutes. */
  readonly dealtAt: number;
  /** The recording fields the hand's command was sent with; an opened cover records only if they still hold. */
  readonly commandFields?: { recordingGeneration?: number };
}
/**
 * Offers expire fifteen minutes after the server makes them. A hand is treated as spent a little earlier, so a tap near
 * the end does not race the server's clock; a spent hand is replaced by a fresh one rather than refused.
 */
const HAND_LIFE_MS = 14 * 60_000;
const isCovered = (offer: EncounterOffer): offer is CoveredOffer =>
  offer.metadata.kind === 'scroll' && offer.cover !== undefined;
/** The most passes one request carries (the contract's bound); any more wait for the next request. */
const PASSES_PER_REQUEST = 9;
/** How long a cover was on screen, in the coarse bands a pass is reported in. Under 1.5 s is a glance, not a reading. */
function onScreenBand(ms: number): CoverPass['onScreen'] {
  return ms < 1500 ? 'under_1_5s' : ms <= 5000 ? '1_5s_to_5s' : 'over_5s';
}
/** Passes and cover time are personal: they are sent only with a command made while recording is on (an odd generation). */
const recordingOn = (fields: { recordingGeneration?: number } | undefined) =>
  fields?.recordingGeneration !== undefined && fields.recordingGeneration % 2 === 1;
/** The covers an outcome deals: only when its first offer is a Scroll with a cover. A Reel first plays as before. */
function coveredOffers(outcome: ReadyOutcome): readonly CoveredOffer[] | undefined {
  if (!isCovered(outcome.offer)) return undefined;
  return [outcome.offer, ...outcome.bufferedOffers].filter(isCovered);
}
/**
 * A move to a new subject names the format the person is in, so "next" stays a Reel after a Reel and a
 * Scroll after a Scroll; the other moves are not about format. The server falls back to the other
 * format only when nothing of this one is left.
 */
const inFormat = (intent: Intent, format: 'reel' | 'scroll'): Intent =>
  intent.mode === 'vertical' ? { ...intent, format } : intent;
type OfferActivation = Extract<
  Awaited<ReturnType<AccountScope['api']['experience']['activateExposure']>>,
  { sessionId: string }
>;
interface Work {
  region?: true;
  /**
   * E08: stop at the ready offers and let the person pick one before anything is activated. `back` is
   * what to show again if they leave without picking; `picked` is set once they have.
   */
  choose?: { readonly back: Pick<EncounterState, 'phase' | 'outcome'>; picked?: true };
  /** A move the system chooses: with covers on, its Scroll offers become a hand instead of opening. */
  deal?: true;
  /** Opening this cover of a hand. */
  fromCover?: { readonly handId: string; readonly index: number };
  /** What opening it reports: how long its cover was on screen, and covers passed before it. */
  coverReport?: { readonly coverMs: number; readonly passes: readonly CoverPass[] };
  uncertain?: boolean;
  keep?: { mode: 'resume' | 'top'; expected?: AvailableKeep; selected?: KeepEntryRef; handle?: KeepPlaceHandle };
  command: (fields: { recordingGeneration?: number }) => Promise<NavigationOutcome>;
  commandFields?: { recordingGeneration?: number };
  activationBody?: ActivateExposureRequest;
  outcome?: NavigationOutcome;
  activateId: string;
  activation?: OfferActivation;
  entry?: EncounterEntry;
}

const capabilityKey = (value: ClientCapabilities | undefined) =>
  value &&
  JSON.stringify([
    value.documentSchemas,
    Object.keys(value.blocks)
      .sort()
      .map((key) => [key, value.blocks[key]]),
  ]);

/** One in-memory controller per AccountScope. Component unmounts park; only scope end disposes. */
export function createEncounterSession(scope: AccountScope, newId: () => string) {
  const history = createEncounterHistory(scope, 20, (entry, captured) => {
    const handle = checkpointFor(entry);
    if (!valid() || !entry.context.actions.saved || !handle) return;
    const position = checkpointPosition(entry, captured);
    const current = handle.getState();
    if (!position || current.status !== 'ready' || current.snapshot?.status !== 'available') return;
    if (
      current.snapshot.place.status === 'set' &&
      JSON.stringify(current.snapshot.place.position) === JSON.stringify(position)
    )
      return;
    handle.setPosition(position);
  });
  const removal = savedRemovalFor(scope, newId);
  const feedback = feedbackFor({ scope, newId });
  const listeners = new Set<() => void>();
  let state: EncounterState = { phase: 'idle', trail: [], overlay: false, surfaceRevision: 0 };
  let live = true;
  let foreground = false;
  let busy = false;
  let work: Work | undefined;
  let regionOrigin: { returnToMap: () => void; label: string; entry?: string; returned: boolean } | undefined;
  let latestSession: { sessionId: string; intentRevision: number } | undefined;
  /** The last hand dealt; it outlives its screen so Back from a cover's essay can return to it. */
  let hand: CoverHand | undefined;
  /** A cover's offer turned out spent: once the failed open has unwound, a fresh hand is dealt. */
  let redealAfterRun = false;
  /** How long each cover of the session has been on screen, by offer, and since when the one showing now has been. */
  const coverTime = new Map<string, number>();
  let coverShownSince: { readonly offerId: string; readonly at: number } | undefined;
  /** Covers moved past and not yet reported; they go with the next open of a cover or request for more (#748). */
  const pendingPasses = new Map<string, CoverPass>();
  let action: { readonly input: ApplyActionRequest; readonly entry: EncounterEntry } | undefined;
  let actionRunning = false;
  let contextSerial = 0;
  let checkpoint: KeepPlaceHandle | undefined;
  let checkpointOwner: { entry: EncounterEntry; assetId: string; assetRevision: number } | undefined;
  let checkpointOff: (() => void) | undefined;
  let checkpointSerial = 0;
  const retiring = new Map<KeepPlaceHandle, () => void>();
  function retire(handle: KeepPlaceHandle) {
    const complete = () => {
      const current = handle.getState();
      if (current.write !== 'idle' && current.status !== 'ended') return;
      retiring.get(handle)?.();
      retiring.delete(handle);
      handle.release();
    };
    retiring.set(handle, handle.subscribe(complete));
    complete();
  }
  function releaseCheckpoint() {
    checkpointSerial++;
    checkpointOff?.();
    checkpointOff = undefined;
    if (checkpoint) {
      const current = checkpoint.getState();
      if (live && scope.active && current.write !== 'idle' && retiring.size < 20) retire(checkpoint);
      else checkpoint.release();
    }
    checkpoint = undefined;
    checkpointOwner = undefined;
    if (live && scope.active) publish({ keepPlace: undefined });
  }
  // A scalar Reel position is valid for many assets; handle ownership must be exact, too.
  function checkpointFor(entry = history.current()) {
    return entry &&
      checkpointOwner?.entry === entry &&
      checkpointOwner.assetId === entry.offer.assetId &&
      checkpointOwner.assetRevision === entry.offer.assetRevision
      ? checkpoint
      : undefined;
  }
  const valid = () => live && scope.active;
  const publish = (patch: Partial<EncounterState> = {}) => {
    if (!valid()) return;
    state = { ...state, ...patch, entry: history.current(), trail: history.list() };
    listeners.forEach((listener) => listener());
  };
  const removalOff = removal.subscribe(() => {
    if (!valid()) return;
    publish({ removal: removal.getState() });
    if (removal.getState().status === 'confirmed') void refreshContext();
  });
  function ensureCheckpoint(entry: EncounterEntry) {
    if (checkpointFor(entry)) return checkpointFor(entry);
    releaseCheckpoint();
    checkpoint = keepBridgeFor(scope).retain({
      assetId: entry.offer.assetId,
      assetRevision: entry.offer.assetRevision,
    });
    if (!checkpoint) return undefined;
    checkpointOwner = { entry, assetId: entry.offer.assetId, assetRevision: entry.offer.assetRevision };
    const handle = checkpoint;
    // The newly retained handle now owns any earlier pending command for this exact target.
    for (const [previous, off] of retiring) {
      const target = previous.getState().snapshot?.target;
      if (target?.assetId !== entry.offer.assetId || target.assetRevision !== entry.offer.assetRevision) continue;
      off();
      retiring.delete(previous);
      previous.release();
    }
    checkpointOff = handle.subscribe(() => {
      if (valid() && checkpointFor() === handle) publish({ keepPlace: handle.getState() });
    });
    return handle;
  }
  async function saveActualPlace(entry: EncounterEntry) {
    const handle = ensureCheckpoint(entry);
    if (!handle) return;
    try {
      await refreshKeep(scope, handle);
      if (!valid() || history.current() !== entry || checkpointFor(entry) !== handle || !foreground || state.overlay)
        return;
      const actual = entry.surface?.capture();
      const position = actual && checkpointPosition(entry, actual);
      if (position) handle.setPosition(position);
    } catch {
      if (valid() && checkpointFor(entry) === handle)
        publish({ keepPlace: { ...handle.getState(), status: 'unavailable', reason: 'entry_unavailable' } });
    }
  }
  const latest = (session: { sessionId: string; intentRevision: number } | undefined) => {
    if (
      session &&
      (!latestSession ||
        latestSession.sessionId !== session.sessionId ||
        session.intentRevision > latestSession.intentRevision)
    )
      latestSession = session;
  };
  const context = async (entry: EncounterEntry) => {
    const response = await scope.queryClient.fetchQuery({
      queryKey: scope.queryKey('encounter', 'context', entry.exposureId),
      queryFn: () => scope.api.experience.exposureContext({ exposureId: entry.exposureId }),
      staleTime: 0,
    });
    if (!valid()) return;
    if (
      response.exposureId !== entry.exposureId ||
      response.assetId !== entry.offer.assetId ||
      response.assetRevision !== entry.offer.assetRevision ||
      response.session?.sessionId !== entry.sessionId
    )
      throw new Error('context_lineage');
    entry.context = response;
    latest(response.session);
  };
  async function refreshContext() {
    const entry = history.current();
    if (!entry || !valid()) return;
    const serial = ++contextSerial;
    try {
      await context(entry);
      if (valid() && serial === contextSerial && history.current() === entry) publish({ contextReady: true });
    } catch (error) {
      if (valid() && serial === contextSerial && history.current() === entry) {
        if (state.phase === 'stale' && apiProblem(error)?.status !== 404) publish({ contextReady: false });
        else fail(error);
      }
    }
  }
  function fail(error: unknown) {
    // A refetch that a newer one replaced (after a removal, say) says nothing about the network.
    if (!valid() || error instanceof ScopeEndedError || error instanceof CancelledError) return;
    const problem = apiProblem(error);
    if (
      problem?.code === 'INTENT_REVISION_STALE' ||
      problem?.code === 'ASSET_REVISION_STALE' ||
      problem?.code === 'OFFER_UNAVAILABLE'
    ) {
      work = undefined; // This old intent must never be automatically resubmitted with a new revision.
      history.park();
      publish({ phase: 'stale', contextReady: false, covers: undefined });
      void refreshContext();
      return;
    }
    if (
      problem &&
      ['NOT_FOUND', 'ASSET_NOT_FOUND', 'UNAUTHENTICATED', 'PRIVACY_EPOCH_CHANGED', 'UNIVERSE_UNAVAILABLE'].includes(
        problem.code,
      )
    ) {
      history.park();
      work = undefined;
      publish({ phase: 'revoked', covers: undefined });
      return;
    }
    // A failure is shown on its own screen with its retry, never behind a cover that can no longer move.
    publish({ phase: problem ? 'error' : 'offline', covers: undefined });
  }
  async function loadEntry(offer: EncounterOffer, activation: OfferActivation): Promise<EncounterEntry> {
    const exposureId = activation.exposureId;
    const response = await scope.api.experience.exposureContext({ exposureId });
    if (!valid()) throw new ScopeEndedError();
    if (
      response.exposureId !== exposureId ||
      response.assetId !== offer.assetId ||
      response.assetRevision !== offer.assetRevision ||
      response.session?.sessionId !== activation.sessionId
    )
      throw new Error('context_lineage');
    latest(response.session);
    scope.queryClient.setQueryData(scope.queryKey('encounter', 'context', exposureId), response);
    const common = {
      offer,
      exposureId,
      sessionId: activation.sessionId,
      context: response,
      position: work?.keep ? undefined : readResume(scope, offer.assetId, offer.assetRevision),
      ...(work?.keep ? { keepOrigin: true } : {}),
      ...(work?.fromCover ? { fromCover: work.fromCover } : {}),
      restored: offer.relation.kind === 'return',
      started: false,
      suspended: false,
      disposed: false,
    };
    const exposure = {
      exposureId,
      assetId: offer.assetId,
      assetRevision: offer.assetRevision,
      // Both the offer's original producer and activation must belong to this generation.
      ...(work?.commandFields?.recordingGeneration !== undefined &&
      work.activationBody?.recordingGeneration === work.commandFields.recordingGeneration
        ? { recordingGeneration: work.commandFields.recordingGeneration, recordingSessionId: work.activateId }
        : {}),
    };
    if (offer.metadata.kind === 'scroll') {
      const loaded = await scope.api.experience.exposureDocument({ exposureId });
      if (!valid()) throw new ScopeEndedError();
      const parsed = parseScrollDocument(loaded.document);
      if (
        parsed.kind !== 'valid' ||
        loaded.exposureId !== exposureId ||
        loaded.assetId !== offer.assetId ||
        loaded.assetRevision !== offer.assetRevision ||
        parsed.document.assetId !== offer.assetId ||
        parsed.document.revision !== offer.assetRevision
      )
        throw new Error('document_lineage');
      const lineage = { ...exposure, degradedEssential: loaded.degradedEssential };
      const scroll: AnyOpenedScroll =
        parsed.schema === 'v2'
          ? { ...lineage, document: parsed.document }
          : parsed.schema === 'v3'
            ? { ...lineage, document: parsed.document }
            : { ...lineage, document: parsed.document };
      return {
        ...common,
        kind: 'scroll',
        scroll,
        recorder: createScrollRecorder({ exposure, scope, newId }),
      };
    }
    const grant = await scope.api.media.grant({ exposureId });
    if (!valid()) throw new ScopeEndedError();
    if (grant.document.assetId !== offer.assetId || grant.document.revision !== offer.assetRevision)
      throw new Error('media_lineage');
    return {
      ...common,
      kind: 'reel',
      document: grant.document,
      mediaGrant: { path: grant.path, expiresAt: grant.expiresAt },
      recorder: createReelRecorder({ exposure, durationMs: grant.document.durationMs, scope, newId }),
    };
  }
  async function run() {
    if (busy || !valid() || !work) return;
    busy = true;
    const current = work;
    try {
      if (current.keep && (current.keep.mode === 'resume' || current.keep.selected) && !current.outcome) {
        const fresh =
          current.keep.handle &&
          (await (current.keep.mode === 'resume'
            ? refreshKeep(scope, current.keep.handle)
            : refreshKeep(scope, current.keep.handle, true)));
        if (!valid() || work !== current) return;
        if (
          !fresh ||
          (current.keep.selected &&
            (fresh.entry.assetId !== current.keep.selected.assetId ||
              fresh.entry.assetRevision !== current.keep.selected.assetRevision ||
              fresh.entry.savedEntryId !== current.keep.selected.savedEntryId)) ||
          (current.keep.mode === 'resume' &&
            (fresh.status !== 'available' || !current.keep.expected || !sameKeep(fresh, current.keep.expected)))
        ) {
          publish({ phase: 'keep_blocked' });
          return;
        }
      }
      if (!current.outcome) {
        publish({ phase: 'opening', actionFailed: false });
        current.commandFields ??= Object.freeze(await recordingCommandFields(scope));
        if (!valid() || work !== current) return;
        current.outcome = await current.command(current.commandFields);
        if (!valid() || work !== current) return;
        latest(current.outcome);
      }
      const outcome = current.outcome;
      if (outcome.status !== 'ready') {
        current.keep?.handle?.release();
        work = undefined;
        publish({ phase: outcome.status, outcome, covers: undefined });
        return;
      }
      publish({ phase: 'ready_offer', outcome });
      if (current.choose && !current.choose.picked && outcome.bufferedOffers.length > 0) {
        publish({ choices: [outcome.offer, ...outcome.bufferedOffers] });
        return;
      }
      const covered = current.deal ? coveredOffers(outcome) : undefined;
      if (covered) {
        dealHand(outcome, covered, current.commandFields);
        return;
      }
      // Prepared offers cannot activate while the tab/app is backgrounded.
      if (!foreground) return;
      history.park();
      publish({ phase: 'activating', choices: undefined });
      if (!current.activation) {
        const body = current.activationBody ?? (await activationBodyOf(current, outcome));
        current.activationBody = body;
        if (!valid() || work !== current) return;
        const activated = ActivateOfferResponseSchema.parse(await scope.api.experience.activateExposure(body));
        if (!valid() || work !== current) return;
        if (
          activated.commandId !== current.activateId ||
          activated.sessionId !== outcome.sessionId ||
          activated.intentRevision !== outcome.intentRevision ||
          activated.kind !== outcome.offer.metadata.kind ||
          activated.offerId !== outcome.offer.offerId ||
          activated.assetId !== outcome.offer.assetId ||
          activated.assetRevision !== outcome.offer.assetRevision
        )
          throw new Error('activation_lineage');
        current.activation = activated;
      }
      current.entry ??= await loadEntry(outcome.offer, current.activation);
      if (!valid() || work !== current) {
        current.entry?.recorder.end();
        return;
      }
      if (current.keep) {
        await context(current.entry);
        if (!valid() || work !== current || !foreground) return;
        if (current.keep.mode === 'resume' || current.keep.selected) {
          const fresh =
            current.keep.handle &&
            (await (current.keep.mode === 'resume'
              ? refreshKeep(scope, current.keep.handle)
              : refreshKeep(scope, current.keep.handle, true)));
          if (!valid() || work !== current) return;
          if (
            !fresh ||
            (current.keep.selected &&
              (fresh.entry.assetId !== current.keep.selected.assetId ||
                fresh.entry.assetRevision !== current.keep.selected.assetRevision ||
                fresh.entry.savedEntryId !== current.keep.selected.savedEntryId)) ||
            (current.keep.mode === 'resume' &&
              (fresh.status !== 'available' || !current.keep.expected || !sameKeep(fresh, current.keep.expected)))
          ) {
            publish({ phase: 'keep_blocked' });
            return;
          }
          current.entry.position = keepPositionFor(
            current.entry,
            current.keep.mode === 'resume' && fresh.status === 'available' ? fresh : undefined,
          );
        } else current.entry.position = keepPositionFor(current.entry);
        if (!current.entry.position) {
          publish({ phase: 'keep_blocked' });
          return;
        }
        current.entry.restored = true;
        current.keep.handle?.release();
        current.keep.handle = undefined;
      }
      releaseCheckpoint();
      history.push(current.entry);
      if (current.region && regionOrigin) regionOrigin.entry = current.entry.exposureId;
      work = undefined;
      publish({ phase: 'active', outcome: undefined, covers: undefined });
    } catch (error) {
      if (current.region && valid() && work === current) {
        const problem = apiProblem(error);
        if (!problem || problem.status >= 500) current.uncertain = true;
        if (current.uncertain) {
          // A later refusal does not prove an earlier ambiguous send was never committed.
          history.park();
          publish({ phase: problem ? 'error' : 'offline', covers: undefined });
          return;
        }
      }
      if (current.keep && valid() && work === current) publish({ phase: 'keep_blocked', covers: undefined });
      else if (current.fromCover && valid() && work === current && spentOffer(error)) {
        // The cover outlived its offer (or the session moved on in another tab): deal a fresh hand, never "path changed".
        work = undefined;
        redealAfterRun = true;
      } else fail(error);
    } finally {
      busy = false;
      if (redealAfterRun) {
        redealAfterRun = false;
        moreCovers();
      }
    }
  }
  /**
   * The activation of an offer, made once and reused unchanged on a retry. A cover's report rides on its own activation,
   * and only while recording is on: paused, nothing personal is sent.
   */
  async function activationBodyOf(current: Work, outcome: ReadyOutcome): Promise<ActivateExposureRequest> {
    const fields = await recordingCommandFields(scope);
    const report = current.coverReport && recordingOn(fields) ? current.coverReport : undefined;
    return freezeRecordingCommand({
      ...fields,
      ...(report ? { coverMs: report.coverMs } : {}),
      ...(report && report.passes.length > 0 ? { passes: [...report.passes] } : {}),
      commandId: current.activateId,
      target: {
        kind: 'offer',
        sessionId: outcome.sessionId,
        offerId: outcome.offer.offerId,
        expectedIntentRevision: outcome.intentRevision,
      },
    });
  }
  /**
   * A refusal that means the offer itself can no longer be opened (it outlived its fifteen minutes, or its Scroll went),
   * as opposed to the network, the account, or a session another tab moved on, which the stale screen handles.
   */
  function spentOffer(error: unknown) {
    return apiProblem(error)?.code === 'OFFER_UNAVAILABLE';
  }
  /** Shows the Scroll offers of a system-chosen move as a hand of covers; the entry on screen is put down, not left. */
  function dealHand(outcome: ReadyOutcome, offers: readonly CoveredOffer[], commandFields?: Work['commandFields']) {
    work = undefined;
    history.park();
    hand = {
      id: newId(),
      outcome,
      offers,
      index: 0,
      ...(history.current() ? { origin: history.current()!.exposureId } : {}),
      dealtAt: Date.now(),
      ...(commandFields ? { commandFields } : {}),
    };
    // Time kept for covers of earlier hands is no longer needed once nothing waits to report it.
    for (const offerId of [...coverTime.keys()]) if (!pendingPasses.has(offerId)) coverTime.delete(offerId);
    publish({ phase: 'covers', outcome: undefined, covers: hand });
    clockCover();
  }
  /** Starts the clock of the cover on screen now; the one before it stops. A cover counts only while Explore is in front. */
  function clockCover() {
    stopCoverClock();
    const shown = state.covers;
    if (shown && foreground && state.phase === 'covers')
      coverShownSince = { offerId: shown.offers[shown.index]!.offerId, at: Date.now() };
  }
  function stopCoverClock() {
    if (!coverShownSince) return;
    const { offerId, at } = coverShownSince;
    coverTime.set(offerId, (coverTime.get(offerId) ?? 0) + Math.max(0, Date.now() - at));
    coverShownSince = undefined;
  }
  /** The cover on screen was moved past without being opened: a pass, reported with the next open or request for more. */
  function passShown(way: CoverPass['way']) {
    const shown = state.covers;
    if (!shown) return;
    stopCoverClock();
    const offerId = shown.offers[shown.index]!.offerId;
    pendingPasses.set(offerId, { offerId, onScreen: onScreenBand(coverTime.get(offerId) ?? 0), way });
  }
  /** The passes one request carries, taken from the pending ones; a cover being opened is not a pass. */
  function takePasses(opening?: string): CoverPass[] {
    if (opening !== undefined) pendingPasses.delete(opening);
    const taken = [...pendingPasses.values()].slice(0, PASSES_PER_REQUEST);
    for (const pass of taken) pendingPasses.delete(pass.offerId);
    return taken;
  }
  /** Whether the hand is still the session's latest and its offers have life left, so one of them can still open. */
  function handOpen(candidate: CoverHand | undefined): candidate is CoverHand {
    return (
      candidate !== undefined &&
      candidate === hand &&
      latestSession?.sessionId === candidate.outcome.sessionId &&
      latestSession.intentRevision === candidate.outcome.intentRevision &&
      Date.now() - candidate.dealtAt < HAND_LIFE_MS
    );
  }
  /** Moves the hand on screen to another of its covers. */
  function showCover(index: number) {
    if (!hand || state.covers !== hand || index < 0 || index >= hand.offers.length || work || busy) return false;
    // Moving down past a cover passes it; moving back up to an earlier one passes nothing.
    if (index > hand.index) passShown('next_cover');
    hand = { ...hand, index };
    publish({ covers: hand });
    clockCover();
    return true;
  }
  /** Back from the covers: to the entry the hand was dealt over, at its place. With none, Back is not Explore's to take. */
  function leaveCovers() {
    const shown = state.covers;
    if (!shown?.origin) return false;
    if (history.current()?.exposureId !== shown.origin && !history.restore(shown.origin)) return false;
    passShown('left');
    releaseCheckpoint();
    contextSerial += 1;
    publish({ phase: 'active', outcome: undefined, covers: undefined });
    return true;
  }
  /** Back from an essay opened from a cover: to that cover, with the rest of its hand, while the hand can still open. */
  function backToCover(index: number) {
    if (!hand) return false;
    // Step back over the essay to the entry the hand was dealt over, so leaving the covers later lands there.
    if (hand.origin !== undefined && history.list().at(-2)?.exposureId === hand.origin) history.back();
    else history.park();
    releaseCheckpoint();
    contextSerial += 1;
    hand = { ...hand, index };
    publish({ phase: 'covers', outcome: undefined, covers: hand });
    clockCover();
    return true;
  }
  /**
   * Another hand after the one on screen, without opening any of it (#748): the request names that hand's decision, so the
   * server deals Scrolls this session has not dealt, and carries the covers passed since the last report. `way` is how
   * the cover on screen was left, when moving on passes it.
   */
  function moreCovers(way?: CoverPass['way']) {
    if (!valid() || work || busy || actionRunning || action !== undefined) return false;
    const shown = state.covers;
    if (way) passShown(way);
    else stopCoverClock();
    const after =
      shown && latestSession ? { decisionId: shown.outcome.decisionId, format: 'scroll' as const } : undefined;
    return open({ kind: 'discover' }, undefined, undefined, after && { after, passes: takePasses() });
  }
  const begin = (
    command: Work['command'],
    keep?: Work['keep'],
    region = false,
    choose?: Work['choose'],
    deal = false,
  ) => {
    if (!valid() || work || busy || actionRunning) return;
    // A move the person names (Keep, a region, a requested Scroll) leaves the cover on screen behind, a pass, and takes the
    // covers down: its own screens show from here.
    if (state.covers && !deal) {
      passShown('left');
      publish({ covers: undefined });
    }
    work = {
      command,
      activateId: newId(),
      ...(keep ? { keep } : {}),
      ...(region ? { region: true } : {}),
      ...(choose ? { choose } : {}),
      ...(deal ? { deal: true } : {}),
    };
    void run();
  };
  const open = (
    target: { kind: 'discover' } | { kind: 'return'; assetId: string; assetRevision: number },
    keep?: Work['keep'],
    choose?: Work['choose'],
    more?: { readonly after: { decisionId: string; format: 'reel' | 'scroll' }; readonly passes: readonly CoverPass[] },
  ) => {
    if (!valid() || work || busy || actionRunning || action !== undefined) return false;
    target = freezeRecordingCommand(target);
    regionOrigin = undefined;
    const commandId = newId();
    const session = latestSession
      ? { sessionId: latestSession.sessionId, expectedIntentRevision: latestSession.intentRevision }
      : undefined;
    begin(
      async (fields) => {
        const common = freezeRecordingCommand({
          ...fields,
          commandId,
          ...(session ? { session } : {}),
          capabilities: ENCOUNTER_CAPABILITIES,
          ...(more && session ? { after: more.after } : {}),
          // Passes are personal: sent only with a command made while recording is on.
          ...(more && more.passes.length > 0 && recordingOn(fields) ? { passes: [...more.passes] } : {}),
        });
        const result =
          target.kind === 'discover'
            ? await scope.api.experience.openExposure({ ...common, target })
            : await scope.api.experience.openExposure({ ...common, target });
        if (!result.status) throw new Error('expected_navigation_outcome');
        return result;
      },
      keep,
      false,
      choose,
      target.kind === 'discover' && !choose && !keep,
    );
    return true;
  };
  const requestSource = () => {
    const entry = history.current();
    if (!valid() || !entry || state.phase !== 'active') return undefined;
    const context = entry.context;
    if (
      context.exposureId !== entry.exposureId ||
      context.assetId !== entry.offer.assetId ||
      context.assetRevision !== entry.offer.assetRevision
    )
      return undefined;
    if (
      context.session &&
      (context.session.sessionId !== entry.sessionId || latestSession?.sessionId !== entry.sessionId)
    )
      return undefined;
    return {
      exposureId: entry.exposureId,
      assetId: entry.offer.assetId,
      assetRevision: entry.offer.assetRevision,
      ...(context.session
        ? { session: { sessionId: entry.sessionId, expectedIntentRevision: latestSession!.intentRevision } }
        : {}),
    };
  };
  const requests = createRequestSession(scope, newId, requestSource, (target) => {
    if (!foreground || state.overlayOwner !== 'request') return false;
    if (!open(target)) return false;
    setOverlay(false);
    const status = requests.getState().status;
    if (status?.status === 'ready' && status.content.assetId === target.assetId) {
      // Opened: the "ready" notice has done its job; the encounter itself says it is the one asked for.
      requests.dismissNotice();
      publish({ askedFor: { assetId: target.assetId, kind: status.content.metadata.kind } });
    }
    return true;
  });
  const setOverlay = (
    overlay: boolean,
    overlayOwner: 'path' | 'request' | 'share' | 'feedback' = 'path',
    feedbackStart?: 'menu' | 'content_error' | 'abuse',
  ) => {
    if (overlay) history.park();
    else {
      const entry = history.current();
      if (entry) {
        entry.restored = true;
        // A sheet is not a departure: a Reel that was playing under it plays on when it closes.
        entry.resumePlaying = entry.position?.kind === 'reel' && entry.position.playing;
      }
    }
    requests.visible(overlay && overlayOwner === 'request' && foreground);
    publish({
      overlay,
      overlayOwner: overlay ? overlayOwner : undefined,
      feedbackStart: overlay && overlayOwner === 'feedback' ? feedbackStart : undefined,
      surfaceRevision: state.surfaceRevision + (overlay ? 0 : 1),
    });
  };
  const restore = (exposureId: string) => {
    if (work || busy || !history.restore(exposureId)) return;
    releaseCheckpoint();
    contextSerial += 1;
    requests.visible(false);
    publish({ phase: 'active', outcome: undefined, overlay: false, overlayOwner: undefined, covers: undefined });
  };
  /**
   * "Not interested" on the encounter in front: saved first, then on to the next subject. A failed save
   * moves nothing, and asking again repeats it with the same command ID. True once the move is under way.
   */
  async function notInterested() {
    const entry = history.current();
    if (!entry || !valid() || state.phase !== 'active' || busy || work || actionRunning) return false;
    const failed = feedback.getState().notInterested;
    const again = failed.status === 'failed' && failed.step === 'mark' && failed.assetId === entry.offer.assetId;
    const saved = again
      ? (await feedback.retryNotInterested()).done
      : await feedback.markNotInterested(entry.offer.assetId, entry.exposureId);
    if (!saved || !valid() || history.current() !== entry) return saved;
    // The sheet the row was in closes only once the save is kept; a failed save leaves it open to retry.
    if (state.overlay) setOverlay(false);
    navigate({ mode: 'vertical', direction: 'next' });
    return true;
  }
  /** Takes "Not interested" back and, if the person was moved on, returns them to where they were. */
  async function undoNotInterested() {
    const taken = await feedback.undoNotInterested();
    if (taken.done && taken.resume !== undefined && valid()) restore(taken.resume);
    return taken.done;
  }
  /** Repeats the save or the Undo that failed, with the same command ID. */
  async function retryNotInterested() {
    const failed = feedback.getState().notInterested;
    if (failed.status !== 'failed') return false;
    if (failed.step === 'mark') return notInterested();
    const step = await feedback.retryNotInterested();
    if (step.done && step.resume !== undefined && valid()) restore(step.resume);
    return step.done;
  }
  const navigate = (intent: Intent) => {
    const entry = history.current();
    if (
      !entry ||
      !latestSession ||
      !valid() ||
      work ||
      busy ||
      action !== undefined ||
      state.phase === 'stale' ||
      state.phase === 'revoked'
    )
      return;
    const input = freezeRecordingCommand({
      commandId: newId(),
      sessionId: entry.sessionId,
      expectedIntentRevision: latestSession.intentRevision,
      from: { offerId: entry.offer.offerId, exposureId: entry.exposureId },
      intent: inFormat(intent, entry.offer.metadata.kind),
    });
    begin(
      (fields) => scope.api.experience.navigate({ ...input, ...fields }),
      undefined,
      false,
      undefined,
      intent.mode === 'vertical',
    );
  };
  /** Leaves the E08 picker without choosing: back to the ending it came from. */
  function leaveChoices() {
    const back = work?.choose?.back;
    if (!back || busy) return false;
    work = undefined;
    publish({ ...back, choices: undefined });
    return true;
  }
  async function runAction() {
    const pending = action;
    if (!pending || !valid() || actionRunning) return;
    const { input, entry } = pending;
    actionRunning = true;
    const before = entry.context.actions;
    const optimistic = { ...before };
    if (input.kind === 'like' || input.kind === 'unlike') optimistic.liked = input.kind === 'like';
    if (input.kind === 'hide') optimistic.hidden = true;
    entry.context = { ...entry.context, actions: optimistic };
    publish({ actionPending: true, actionFailed: false });
    try {
      const result = await scope.api.experience.applyAction(input);
      if (!valid()) return;
      if (
        result.commandId !== input.commandId ||
        result.assetId !== input.target.assetId ||
        result.assetRevision !== input.target.assetRevision ||
        result.kind !== input.kind
      )
        throw new Error('action_lineage');
      action = undefined;
      entry.context = {
        ...entry.context,
        actions:
          'saved' in result
            ? { ...before, saved: result.saved }
            : { ...before, liked: result.liked, hidden: result.hidden },
      };
      publish({ actionFailed: false });
      if (input.kind === 'save' && 'saved' in result && result.saved && history.current() === entry)
        void saveActualPlace(entry);
      // A failed reconciliation cannot roll back a confirmed command or mint a replacement intent.
      await scope.queryClient.invalidateQueries({ queryKey: scope.queryKey('saved') }).catch(() => undefined);
      await context(entry).catch(() => undefined);
    } catch {
      if (!valid()) return;
      entry.context = { ...entry.context, actions: before };
      publish({ actionFailed: true }); // Unknown outcome retains exactly the same command for retry.
    } finally {
      actionRunning = false;
      if (valid()) publish({ actionPending: false });
    }
  }
  const end = () => {
    if (!live) return;
    live = false;
    removalOff();
    releaseCheckpoint();
    for (const [handle, off] of retiring) {
      off();
      handle.release();
    }
    retiring.clear();
    work?.keep?.handle?.release();
    work?.entry?.recorder.end();
    work = undefined;
    hand = undefined;
    coverShownSince = undefined;
    coverTime.clear();
    pendingPasses.clear();
    regionOrigin = undefined;
    action = undefined;
    history.end();
    latestSession = undefined;
    state = { phase: 'revoked', trail: [], overlay: false, surfaceRevision: 0 };
    listeners.forEach((listener) => listener());
    listeners.clear();
  };
  scope.onEnd?.(end);
  return {
    getState: () => state,
    subscribe(this: void, listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    open,
    /** `alternate` opens the card's other format of the same explanation, exactly, when the card names one (#709). */
    openRegion(
      displayed: AvailableRegionPreview,
      label: string,
      returnToMap: () => void,
      choice: 'encounter' | 'alternate' = 'encounter',
    ) {
      if (!valid() || work || busy || actionRunning || action !== undefined) return false;
      const preview = RegionEncounterPreviewResponseSchema.safeParse(displayed);
      if (
        !preview.success ||
        preview.data.status !== 'available' ||
        preview.data.scope.universeId !== scope.account.universeId ||
        preview.data.scope.privacyEpoch !== scope.account.privacyEpoch ||
        capabilityKey(preview.data.capabilities) !== capabilityKey(ENCOUNTER_CAPABILITIES)
      )
        return false;
      const card = preview.data;
      const chosen = choice === 'alternate' ? card.alternate : card.encounter;
      if (!chosen) return false;
      const expectedEncounter = { assetId: chosen.assetId, assetRevision: chosen.assetRevision };
      const input = RegionEncounterOpenRequestSchema.parse({
        version: 'region-encounter-open.v1',
        commandId: newId(),
        target: card.target,
        capabilities: ENCOUNTER_CAPABILITIES,
        expectedEncounter,
        ...(latestSession
          ? { session: { sessionId: latestSession.sessionId, expectedIntentRevision: latestSession.intentRevision } }
          : {}),
      });
      regionOrigin = { returnToMap, label, returned: false };
      begin(
        async (fields) => {
          const raw = await scope.api.experience.openRegionEncounter({ ...input, ...fields });
          const reply = RegionEncounterOpenResponseSchema.parse(raw);
          if (
            reply.universeId !== scope.account.universeId ||
            reply.privacyEpoch !== scope.account.privacyEpoch ||
            JSON.stringify(reply.target) !== JSON.stringify(input.target) ||
            JSON.stringify(reply.expectedEncounter) !== JSON.stringify(input.expectedEncounter) ||
            capabilityKey(reply.capabilities) !== capabilityKey(input.capabilities) ||
            reply.outcome.commandId !== input.commandId ||
            reply.outcome.revision < card.scope.personalWatermark ||
            (input.session &&
              (reply.outcome.sessionId !== input.session.sessionId ||
                reply.outcome.intentRevision < input.session.expectedIntentRevision)) ||
            (reply.outcome.status === 'ready' && reply.outcome.offer.metadata.kind !== card.encounter.metadata.kind)
          )
            throw new Error('region_lineage');
          return reply.outcome;
        },
        undefined,
        true,
      );
      publish();
      return true;
    },
    openKept(
      target: { assetId: string; assetRevision: number },
      mode: 'resume' | 'top',
      expected?: AvailableKeep,
      selected?: KeepEntryRef,
    ) {
      if (!valid() || work || busy || actionRunning || action !== undefined) return false;
      if (
        mode === 'resume' &&
        (!expected ||
          expected.entry.assetId !== target.assetId ||
          expected.entry.assetRevision !== target.assetRevision ||
          expected.place.status !== 'set')
      )
        return false;
      const ref = { assetId: target.assetId, assetRevision: target.assetRevision };
      const membership = selected ?? expected?.entry;
      if (membership && membership.assetId !== target.assetId) return false;
      const handle =
        mode === 'resume' || membership
          ? keepBridgeFor(scope).retain({
              assetId: membership?.assetId ?? ref.assetId,
              assetRevision: membership?.assetRevision ?? ref.assetRevision,
            })
          : undefined;
      if ((mode === 'resume' || membership) && !handle) return false;
      const accepted = open({ kind: 'return', ...ref }, { mode, expected, selected: membership, handle });
      if (!accepted) handle?.release();
      return accepted;
    },
    startKeepFromTop() {
      if (!valid() || !work?.keep || busy || state.phase !== 'keep_blocked') return;
      work.keep.mode = 'top';
      // Starting at the top changes position choice, never the displayed membership binding.
      if (!work.keep.selected) {
        work.keep.handle?.release();
        work.keep.handle = undefined;
      }
      void run();
    },
    leaveKeep() {
      if (busy || !work?.keep) return false;
      work.keep.handle?.release();
      work.entry?.recorder.end();
      work = undefined;
      publish({ phase: history.current() ? 'active' : 'idle' });
      return true;
    },
    async keepThisPlace() {
      const entry = history.current();
      if (!valid() || !foreground || state.overlay || state.phase !== 'active' || !entry || entry.disposed) return;
      const capture = entry.surface?.capture();
      const position = capture && checkpointPosition(entry, capture);
      if (!position) return;
      ensureCheckpoint(entry);
      const handle = checkpointFor(entry);
      if (!handle) {
        publish({ keepPlace: { status: 'unavailable', write: 'idle', reason: 'entry_unavailable' } });
        return;
      }
      const serial = ++checkpointSerial;
      publish({ keepPlace: handle.getState() });
      try {
        await refreshKeep(scope, handle);
        if (
          !valid() ||
          serial !== checkpointSerial ||
          checkpointFor(entry) !== handle ||
          history.current() !== entry ||
          !foreground ||
          !entry.surface ||
          state.overlay ||
          state.phase !== 'active'
        )
          return;
        handle.setPosition(position);
      } catch {
        if (valid() && serial === checkpointSerial && checkpointFor() === handle)
          publish({ keepPlace: { ...handle.getState(), status: 'unavailable', reason: 'entry_unavailable' } });
      }
    },
    retryKeep: () => checkpointFor()?.retry() ?? false,
    refreshKeep: () => checkpointFor()?.refresh(),
    resolveKeepConflict: (choice: 'server' | 'candidate') => checkpointFor()?.resolveConflict(choice) ?? false,
    navigate,
    /**
     * E08 "Something different": asks for a fresh subject and, when the feed offers more than one,
     * stops at the offers so the person picks. With a single offer it opens it as before.
     */
    chooseDirection() {
      return open({ kind: 'discover' }, undefined, { back: { phase: state.phase, outcome: state.outcome } });
    },
    /** Opens the picked offer; the others stay unactivated and unrecorded. */
    pickDirection(offerId: string) {
      const outcome = work?.outcome;
      if (!work?.choose || outcome?.status !== 'ready' || busy) return;
      const picked = [outcome.offer, ...outcome.bufferedOffers].find((offer) => offer.offerId === offerId);
      if (!picked) return;
      const others = [outcome.offer, ...outcome.bufferedOffers].filter((offer) => offer.offerId !== offerId);
      work.choose.picked = true;
      work.outcome = { ...outcome, offer: picked, bufferedOffers: others };
      void run();
    },
    leaveChoices,
    /**
     * Opens the cover on screen: the only thing that activates an offer of a hand. A hand past its offers' life is
     * replaced by a fresh one instead, so a tap is never answered with "Your path changed".
     */
    openCover() {
      const shown = state.covers;
      if (!valid() || !shown || shown !== hand || work || busy || actionRunning || action !== undefined) return false;
      if (!handOpen(shown)) return moreCovers();
      const picked = shown.offers[shown.index]!;
      const others = [shown.outcome.offer, ...shown.outcome.bufferedOffers].filter(
        (offer) => offer.offerId !== picked.offerId,
      );
      stopCoverClock();
      // The contract's bound; the server clamps it again to the time since the offer was made, on its own clock.
      const coverMs = Math.min(900_000, Math.round(coverTime.get(picked.offerId) ?? 0));
      work = {
        command: () => Promise.resolve(shown.outcome),
        activateId: newId(),
        outcome: { ...shown.outcome, offer: picked, bufferedOffers: others },
        ...(shown.commandFields ? { commandFields: shown.commandFields } : {}),
        fromCover: { handId: shown.id, index: shown.index },
        coverReport: { coverMs, passes: takePasses(picked.offerId) },
      };
      void run();
      return true;
    },
    /** The next cover of the hand; after the last, another hand. */
    nextCover() {
      const shown = state.covers;
      if (!shown || shown !== hand) return false;
      return shown.index < shown.offers.length - 1 ? showCover(shown.index + 1) : moreCovers('more_covers');
    },
    /** The cover before this one in the same hand. An earlier hand is gone once more covers were asked for. */
    previousCover() {
      const shown = state.covers;
      return shown !== undefined && shown === hand && showCover(shown.index - 1);
    },
    /** Another hand after the last cover, the cover on screen passed by asking. */
    moreCovers: () => moreCovers('more_covers'),
    requests,
    openRequest(mode: RequestMode = 'topic', anchor?: AskAnchor) {
      if (!valid() || state.phase !== 'active' || busy || work || actionRunning) return;
      if (requests.show(mode, anchor)) setOverlay(true, 'request');
    },
    /** The share sheet: an overlay like the menu, so playback pauses under it and Back closes it. */
    openShare() {
      if (!valid() || state.phase !== 'active' || busy || work || actionRunning) return;
      setOverlay(true, 'share');
    },
    /**
     * P03: the feedback sheet over the encounter, on its menu or straight on a form. An overlay like the
     * others, so playback pauses under it and the position it captures is the moment a report points to.
     */
    openFeedback(start: 'menu' | 'content_error' | 'abuse' = 'menu') {
      if (!valid() || state.phase !== 'active' || busy || work || actionRunning) return;
      setOverlay(true, 'feedback', start);
    },
    feedback,
    notInterested,
    undoNotInterested,
    retryNotInterested,
    /** Opens the finished requested content from the ready notice, without a second tap on the sheet. */
    async openReadyRequest() {
      if (!valid() || state.phase !== 'active' || busy || work || actionRunning) return false;
      if (!requests.show(requests.getState().mode)) return false;
      setOverlay(true, 'request');
      return requests.openReady();
    },
    gesture(move: EncounterGestureMove) {
      const entry = history.current();
      if (!entry || state.phase !== 'active' || !foreground || state.overlay) return;
      if (move === 'subjectNext' || move === 'subjectPrevious') {
        navigate({ mode: 'vertical', direction: move === 'subjectNext' ? 'next' : 'previous' });
        return;
      }
      const target =
        move === 'next' ? entry.context.continuations.seriesNext : entry.context.continuations.seriesPrevious;
      if (target.status === 'ready')
        navigate({
          mode: 'series',
          direction: move,
          expectedContinuation: {
            linkId: target.linkId,
            assetId: target.target.assetId,
            assetRevision: target.target.assetRevision,
          },
        });
      else if (move === 'next' && entry.context.continuations.related.status === 'ready') {
        const related = entry.context.continuations.related;
        navigate({
          mode: 'related',
          expectedContinuation: {
            linkId: related.linkId,
            assetId: related.target.assetId,
            assetRevision: related.target.assetRevision,
          },
        });
      }
    },
    retry() {
      if (state.phase === 'stale') return;
      if (work) {
        void run();
        return;
      }
      const entry = history.current();
      if (!entry || !valid()) return;
      void context(entry)
        .then(() => {
          if (valid() && history.current() === entry)
            publish({ phase: 'active', surfaceRevision: state.surfaceRevision + 1 });
        })
        .catch(fail);
    },
    acknowledgeStale() {
      if (valid() && state.phase === 'stale' && state.contextReady)
        publish({ phase: history.current() ? 'active' : 'idle', surfaceRevision: state.surfaceRevision + 1 });
    },
    refreshContext,
    acceptContext(exposureId: string, response: ExposureContextResponse) {
      const entry = history.current();
      if (!valid() || !entry || entry.exposureId !== exposureId) return;
      if (
        response.exposureId !== exposureId ||
        response.assetId !== entry.offer.assetId ||
        response.assetRevision !== entry.offer.assetRevision ||
        response.session?.sessionId !== entry.sessionId
      ) {
        fail(new Error('context_lineage'));
        return;
      }
      latest(response.session);
      if (entry.context === response) return;
      entry.context = response;
      publish();
    },
    contextFailure(exposureId: string, error: unknown) {
      if (valid() && history.current()?.exposureId === exposureId) fail(error);
    },
    setForeground(value: boolean) {
      const returning = value && !foreground;
      foreground = value;
      if (value && regionOrigin) regionOrigin.returned = false;
      requests.visible(value && state.overlayOwner === 'request' && state.overlay);
      if (returning) {
        const entry = history.current();
        if (entry?.started) history.returnPaused(entry);
        publish({ surfaceRevision: state.surfaceRevision + 1 });
      }
      if (!value) {
        history.park();
        releaseCheckpoint();
        stopCoverClock();
      } else if (returning && state.covers && handOpen(state.covers)) clockCover();
      // Re-entering the route resumes a prepared offer, never an uncertain command automatically.
      if (value && work && !busy && state.phase === 'ready_offer') void run();
      // Covers left on screen past their offers' life are replaced when the person comes back to them.
      if (returning && state.covers && !work && !busy && !handOpen(state.covers)) moreCovers('left');
    },
    bindSurface(entry: EncounterEntry, surface: NonNullable<EncounterEntry['surface']>) {
      if (valid() && !entry.disposed && foreground && history.current() === entry) {
        entry.surface = surface;
        if (entry.context.actions.saved) ensureCheckpoint(entry);
      }
    },
    mediaGrant(entry: EncounterEntry) {
      return {
        active: () => valid() && !entry.disposed,
        get: () => (valid() && !entry.disposed && entry.kind === 'reel' ? entry.mediaGrant : undefined),
        set: (grant: { path: string; expiresAt: string }) => {
          if (valid() && !entry.disposed && entry.kind === 'reel') entry.mediaGrant = grant;
        },
      };
    },
    mount(entry: EncounterEntry) {
      if (!valid() || entry.disposed || !foreground || history.current() !== entry || state.overlay) return;
      if (entry.kind === 'scroll') entry.recorder.start();
      if (entry.suspended) entry.recorder.resume();
      entry.suspended = false;
      entry.started = true;
    },
    park(entry?: EncounterEntry) {
      if (!entry || history.current() === entry) {
        history.park();
        releaseCheckpoint();
      }
    },
    done() {
      requests.visible(false);
      history.park();
      publish({ phase: 'exhausted', outcome: undefined, overlay: false, overlayOwner: undefined, covers: undefined });
    },
    back() {
      if (!valid()) return false;
      if (state.choices) return leaveChoices();
      if (state.overlay) {
        const entry = history.current();
        if (entry) entry.restored = true;
        setOverlay(false);
        return true;
      }
      if (
        regionOrigin &&
        !regionOrigin.returned &&
        (work?.region ||
          !regionOrigin.entry ||
          history.current()?.exposureId === regionOrigin.entry ||
          !history.canBack())
      ) {
        const origin = regionOrigin;
        origin.returned = true;
        foreground = false;
        requests.visible(false);
        history.park();
        releaseCheckpoint();
        publish({ overlay: false, overlayOwner: undefined });
        // The encounter's own history marker is popped by an asynchronous Back; the map is opened after it lands.
        afterPendingBack(origin.returnToMap);
        return true;
      }
      if (work || busy) return false;
      if (state.covers) return leaveCovers();
      const entry = history.current();
      if (entry?.fromCover && handOpen(hand) && entry.fromCover.handId === hand.id)
        return backToCover(entry.fromCover.index);
      if (!history.back()) return false;
      releaseCheckpoint();
      contextSerial += 1;
      // No read, command, activation, or new recorder on Back. Latest server intent remains independent.
      publish({ phase: 'active', outcome: undefined });
      return true;
    },
    restore,
    setOverlay,
    resumeCurrent() {
      if (!work && valid())
        publish({ phase: 'active', outcome: undefined, surfaceRevision: state.surfaceRevision + 1 });
    },
    act(kind: ApplyActionRequest['kind']) {
      const entry = history.current();
      if (!entry || actionRunning || work || !valid()) return;
      if (kind === 'unsave') {
        if (action) return;
        const displayed = state.keepPlace?.snapshot;
        const savedEntryId =
          displayed &&
          displayed.status !== 'not_saved' &&
          displayed.entry.assetId === entry.offer.assetId &&
          displayed.entry.assetRevision === entry.offer.assetRevision
            ? displayed.entry.savedEntryId
            : undefined;
        void removal.prepare({
          savedEntryId,
          assetId: entry.offer.assetId,
          assetRevision: entry.offer.assetRevision,
          metadata: entry.offer.metadata,
        });
        return;
      }
      if (kind === 'save') history.capture();
      if (action) {
        void runAction();
        return;
      }
      actionRunning = true;
      void recordingCommandFields(scope)
        .then((fields) => {
          if (!valid() || history.current() !== entry || work) return;
          action = {
            entry,
            input: freezeRecordingCommand({
              ...fields,
              commandId: newId(),
              kind,
              target: { assetId: entry.offer.assetId, assetRevision: entry.offer.assetRevision },
              exposureId: entry.exposureId,
            }),
          };
        })
        .catch(() => {
          if (valid()) publish({ actionFailed: true });
        })
        .finally(() => {
          actionRunning = false;
          if (action && valid()) void runAction();
        });
    },
    undoRemoval: removal.undo,
    retryRemoval: removal.retry,
    retryAction() {
      void runAction();
    },
    /**
     * U04: where this entry was opened from when it is the encounter a region card opened, for the chip
     * that returns there. Gone once the person has returned or moved on to another entry.
     */
    regionOriginOf(entry: EncounterEntry): string | undefined {
      return regionOrigin && !regionOrigin.returned && regionOrigin.entry === entry.exposureId
        ? regionOrigin.label
        : undefined;
    },
    canBack: () => {
      if (!valid()) return false;
      if (state.choices !== undefined) return true;
      // On covers, Back is Explore's only when there is an entry the hand was dealt over to return to.
      if (state.covers !== undefined) return state.covers.origin !== undefined;
      if (history.current()?.fromCover?.handId === hand?.id && handOpen(hand)) return true;
      return regionOrigin ? !regionOrigin.returned : history.canBack();
    },
    end,
  };
}
export type EncounterSession = ReturnType<typeof createEncounterSession>;
