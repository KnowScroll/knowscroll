import { CancelledError } from '@tanstack/react-query';
import {
  apiProblem,
  recordingCommandFields,
  freezeRecordingCommand,
  createReelRecorder,
  createScrollRecorder,
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
} from '@knowscroll/contracts';
import { parseDocument } from '@knowscroll/scroll-model';
import { createRequestSession, type RequestMode } from '../requests/request-session';
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
  readonly actionPending?: boolean;
  readonly actionFailed?: boolean;
  readonly overlay: boolean;
  readonly overlayOwner?: 'path' | 'request' | 'share';
  readonly surfaceRevision: number;
  readonly contextReady?: boolean;
  readonly keepPlace?: KeepPlaceState;
  readonly removal?: SavedRemovalState;
}
type Intent = NavigateExperienceRequest['intent'];
type OfferActivation = Extract<
  Awaited<ReturnType<AccountScope['api']['experience']['activateExposure']>>,
  { sessionId: string }
>;
interface Work {
  region?: true;
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
  const listeners = new Set<() => void>();
  let state: EncounterState = { phase: 'idle', trail: [], overlay: false, surfaceRevision: 0 };
  let live = true;
  let foreground = false;
  let busy = false;
  let work: Work | undefined;
  let regionOrigin: { returnToMap: () => void; entry?: string; returned: boolean } | undefined;
  let latestSession: { sessionId: string; intentRevision: number } | undefined;
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
      publish({ phase: 'stale', contextReady: false });
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
      publish({ phase: 'revoked' });
      return;
    }
    publish({ phase: problem ? 'error' : 'offline' });
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
      const parsed = parseDocument(loaded.document);
      if (
        parsed.kind !== 'valid' ||
        loaded.exposureId !== exposureId ||
        loaded.assetId !== offer.assetId ||
        loaded.assetRevision !== offer.assetRevision ||
        parsed.document.assetId !== offer.assetId ||
        parsed.document.revision !== offer.assetRevision
      )
        throw new Error('document_lineage');
      return {
        ...common,
        kind: 'scroll',
        scroll: { ...exposure, document: parsed.document, degradedEssential: loaded.degradedEssential },
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
        publish({ phase: outcome.status, outcome });
        return;
      }
      publish({ phase: 'ready_offer', outcome });
      // Prepared offers cannot activate while the tab/app is backgrounded.
      if (!foreground) return;
      history.park();
      publish({ phase: 'activating' });
      if (!current.activation) {
        current.activationBody ??= freezeRecordingCommand({
          ...(await recordingCommandFields(scope)),
          commandId: current.activateId,
          target: {
            kind: 'offer',
            sessionId: outcome.sessionId,
            offerId: outcome.offer.offerId,
            expectedIntentRevision: outcome.intentRevision,
          },
        });
        if (!valid() || work !== current) return;
        const activated = ActivateOfferResponseSchema.parse(
          await scope.api.experience.activateExposure(current.activationBody),
        );
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
      publish({ phase: 'active', outcome: undefined });
    } catch (error) {
      if (current.region && valid() && work === current) {
        const problem = apiProblem(error);
        if (!problem || problem.status >= 500) current.uncertain = true;
        if (current.uncertain) {
          // A later refusal does not prove an earlier ambiguous send was never committed.
          history.park();
          publish({ phase: problem ? 'error' : 'offline' });
          return;
        }
      }
      if (current.keep && valid() && work === current) publish({ phase: 'keep_blocked' });
      else fail(error);
    } finally {
      busy = false;
    }
  }
  const begin = (command: Work['command'], keep?: Work['keep'], region = false) => {
    if (!valid() || work || busy || actionRunning) return;
    work = { command, activateId: newId(), ...(keep ? { keep } : {}), ...(region ? { region: true } : {}) };
    void run();
  };
  const open = (
    target: { kind: 'discover' } | { kind: 'return'; assetId: string; assetRevision: number },
    keep?: Work['keep'],
  ) => {
    if (!valid() || work || busy || actionRunning || action !== undefined) return false;
    target = freezeRecordingCommand(target);
    regionOrigin = undefined;
    const commandId = newId();
    const session = latestSession
      ? { sessionId: latestSession.sessionId, expectedIntentRevision: latestSession.intentRevision }
      : undefined;
    begin(async (fields) => {
      const common = freezeRecordingCommand({
        ...fields,
        commandId,
        ...(session ? { session } : {}),
        capabilities: ENCOUNTER_CAPABILITIES,
      });
      const result =
        target.kind === 'discover'
          ? await scope.api.experience.openExposure({ ...common, target })
          : await scope.api.experience.openExposure({ ...common, target });
      if (!result.status) throw new Error('expected_navigation_outcome');
      return result;
    }, keep);
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
    return true;
  });
  const setOverlay = (overlay: boolean, overlayOwner: 'path' | 'request' | 'share' = 'path') => {
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
      surfaceRevision: state.surfaceRevision + (overlay ? 0 : 1),
    });
  };
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
      intent,
    });
    begin((fields) => scope.api.experience.navigate({ ...input, ...fields }));
  };
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
    openRegion(displayed: AvailableRegionPreview, returnToMap: () => void) {
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
      const expectedEncounter = { assetId: card.encounter.assetId, assetRevision: card.encounter.assetRevision };
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
      regionOrigin = { returnToMap, returned: false };
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
    requests,
    openRequest(mode: RequestMode = 'topic') {
      if (!valid() || state.phase !== 'active' || busy || work || actionRunning) return;
      if (requests.show(mode)) setOverlay(true, 'request');
    },
    /** The share sheet: an overlay like the menu, so playback pauses under it and Back closes it. */
    openShare() {
      if (!valid() || state.phase !== 'active' || busy || work || actionRunning) return;
      setOverlay(true, 'share');
    },
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
        if (entry?.started) entry.restored = true;
        publish({ surfaceRevision: state.surfaceRevision + 1 });
      }
      if (!value) {
        history.park();
        releaseCheckpoint();
      }
      // Re-entering the route resumes a prepared offer, never an uncertain command automatically.
      if (value && work && !busy && state.phase === 'ready_offer') void run();
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
      publish({ phase: 'exhausted', outcome: undefined, overlay: false, overlayOwner: undefined });
    },
    back() {
      if (!valid()) return false;
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
        origin.returnToMap();
        return true;
      }
      if (work || busy) return false;
      if (!history.back()) return false;
      releaseCheckpoint();
      contextSerial += 1;
      // No read, command, activation, or new recorder on Back. Latest server intent remains independent.
      publish({ phase: 'active', outcome: undefined });
      return true;
    },
    restore(exposureId: string) {
      if (work || busy || !history.restore(exposureId)) return;
      releaseCheckpoint();
      contextSerial += 1;
      requests.visible(false);
      publish({ phase: 'active', outcome: undefined, overlay: false, overlayOwner: undefined });
    },
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
    canBack: () => valid() && (regionOrigin ? !regionOrigin.returned : history.canBack()),
    end,
  };
}
export type EncounterSession = ReturnType<typeof createEncounterSession>;
