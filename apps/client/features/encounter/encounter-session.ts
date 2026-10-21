import {
  apiProblem,
  createReelRecorder,
  createScrollRecorder,
  ScopeEndedError,
  type AccountScope,
  type KeepPlaceHandle,
  type KeepPlaceState,
} from '@knowscroll/client-core';
import type {
  ApplyActionRequest,
  EncounterOffer,
  ExposureContextResponse,
  NavigateExperienceRequest,
  NavigationOutcome,
} from '@knowscroll/contracts';
import { parseDocument } from '@knowscroll/scroll-model';
import { createRequestSession, type RequestMode } from '../requests/request-session';
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
  readonly overlayOwner?: 'path' | 'request';
  readonly surfaceRevision: number;
  readonly contextReady?: boolean;
  readonly keepPlace?: KeepPlaceState;
}
type Intent = NavigateExperienceRequest['intent'];
type OfferActivation = Extract<
  Awaited<ReturnType<AccountScope['api']['experience']['activateExposure']>>,
  { sessionId: string }
>;
interface Work {
  keep?: { mode: 'resume' | 'top'; expected?: AvailableKeep; handle?: KeepPlaceHandle };
  command: () => Promise<NavigationOutcome>;
  outcome?: NavigationOutcome;
  activateId: string;
  activation?: OfferActivation;
  entry?: EncounterEntry;
}

/** One in-memory controller per AccountScope. Component unmounts park; only scope end disposes. */
export function createEncounterSession(scope: AccountScope, newId: () => string) {
  const history = createEncounterHistory(scope);
  const listeners = new Set<() => void>();
  let state: EncounterState = { phase: 'idle', trail: [], overlay: false, surfaceRevision: 0 };
  let live = true;
  let foreground = false;
  let busy = false;
  let work: Work | undefined;
  let latestSession: { sessionId: string; intentRevision: number } | undefined;
  let action: { readonly input: ApplyActionRequest; readonly entry: EncounterEntry } | undefined;
  let actionRunning = false;
  let contextSerial = 0;
  let checkpoint: KeepPlaceHandle | undefined;
  let checkpointOwner: { entry: EncounterEntry; assetId: string; assetRevision: number } | undefined;
  let checkpointOff: (() => void) | undefined;
  let checkpointSerial = 0;
  function releaseCheckpoint() {
    checkpointSerial++;
    checkpointOff?.();
    checkpointOff = undefined;
    checkpoint?.release();
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
    if (!valid() || error instanceof ScopeEndedError) return;
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
    const exposure = { exposureId, assetId: offer.assetId, assetRevision: offer.assetRevision };
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
      if (current.keep?.mode === 'resume' && !current.outcome) {
        const fresh = current.keep.handle && (await refreshKeep(scope, current.keep.handle));
        if (!valid() || work !== current) return;
        if (!fresh || !current.keep.expected || !sameKeep(fresh, current.keep.expected)) {
          publish({ phase: 'keep_blocked' });
          return;
        }
      }
      if (!current.outcome) {
        publish({ phase: 'opening', actionFailed: false });
        current.outcome = await current.command();
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
        const activated = await scope.api.experience.activateExposure({
          commandId: current.activateId,
          target: {
            kind: 'offer',
            sessionId: outcome.sessionId,
            offerId: outcome.offer.offerId,
            expectedIntentRevision: outcome.intentRevision,
          },
        });
        if (!valid() || work !== current) return;
        if (
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
        if (current.keep.mode === 'resume') {
          const fresh = current.keep.handle && (await refreshKeep(scope, current.keep.handle));
          if (!valid() || work !== current) return;
          if (!fresh || !current.keep.expected || !sameKeep(fresh, current.keep.expected)) {
            publish({ phase: 'keep_blocked' });
            return;
          }
          current.entry.position = keepPositionFor(current.entry, fresh);
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
      work = undefined;
      publish({ phase: 'active', outcome: undefined });
    } catch (error) {
      if (current.keep && valid() && work === current) publish({ phase: 'keep_blocked' });
      else fail(error);
    } finally {
      busy = false;
    }
  }
  const begin = (command: () => Promise<NavigationOutcome>, keep?: Work['keep']) => {
    if (!valid() || work || busy || actionRunning) return;
    work = { command, activateId: newId(), ...(keep ? { keep } : {}) };
    void run();
  };
  const open = (
    target: { kind: 'discover' } | { kind: 'return'; assetId: string; assetRevision: number },
    keep?: Work['keep'],
  ) => {
    if (!valid() || work || busy || actionRunning || action !== undefined) return false;
    const commandId = newId();
    const session = latestSession
      ? { sessionId: latestSession.sessionId, expectedIntentRevision: latestSession.intentRevision }
      : undefined;
    begin(async () => {
      const common = { commandId, ...(session ? { session } : {}), capabilities: ENCOUNTER_CAPABILITIES };
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
  const setOverlay = (overlay: boolean, overlayOwner: 'path' | 'request' = 'path') => {
    if (overlay) history.park();
    else {
      const entry = history.current();
      if (entry) entry.restored = true;
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
    const input = {
      commandId: newId(),
      sessionId: entry.sessionId,
      expectedIntentRevision: latestSession.intentRevision,
      from: { offerId: entry.offer.offerId, exposureId: entry.exposureId },
      intent,
    };
    begin(() => scope.api.experience.navigate(input));
  };
  async function runAction() {
    const pending = action;
    if (!pending || !valid() || actionRunning) return;
    const { input, entry } = pending;
    actionRunning = true;
    const before = entry.context.actions;
    const optimistic = { ...before };
    if (input.kind === 'save' || input.kind === 'unsave') optimistic.saved = input.kind === 'save';
    if (input.kind === 'like' || input.kind === 'unlike') optimistic.liked = input.kind === 'like';
    if (input.kind === 'hide') optimistic.hidden = true;
    entry.context = { ...entry.context, actions: optimistic };
    publish({ actionPending: true, actionFailed: false });
    try {
      const result = await scope.api.experience.applyAction(input);
      if (!valid()) return;
      if (
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
    releaseCheckpoint();
    work?.keep?.handle?.release();
    work?.entry?.recorder.end();
    work = undefined;
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
    openKept(target: { assetId: string; assetRevision: number }, mode: 'resume' | 'top', expected?: AvailableKeep) {
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
      const handle = mode === 'resume' ? keepBridgeFor(scope).retain(ref) : undefined;
      if (mode === 'resume' && !handle) return false;
      const accepted = open({ kind: 'return', ...ref }, { mode, expected, handle });
      if (!accepted) handle?.release();
      return accepted;
    },
    startKeepFromTop() {
      if (!valid() || !work?.keep || busy || state.phase !== 'keep_blocked') return;
      work.keep.mode = 'top';
      work.keep.handle?.release();
      work.keep.handle = undefined;
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
      if (!checkpointFor(entry)) {
        releaseCheckpoint();
        checkpoint = keepBridgeFor(scope).retain({
          assetId: entry.offer.assetId,
          assetRevision: entry.offer.assetRevision,
        });
        if (checkpoint)
          checkpointOwner = { entry, assetId: entry.offer.assetId, assetRevision: entry.offer.assetRevision };
      }
      const handle = checkpointFor(entry);
      if (!handle) {
        publish({ keepPlace: { status: 'unavailable', write: 'idle', reason: 'entry_unavailable' } });
        return;
      }
      if (!checkpointOff)
        checkpointOff = handle.subscribe(() => {
          if (valid() && checkpointFor() === handle) publish({ keepPlace: handle.getState() });
        });
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
      if (value && work && !busy) void run();
    },
    bindSurface(entry: EncounterEntry, surface: NonNullable<EncounterEntry['surface']>) {
      if (valid() && !entry.disposed && foreground && history.current() === entry) entry.surface = surface;
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
      if (kind === 'save') history.capture();
      if (!action)
        action = {
          entry,
          input: {
            commandId: newId(),
            kind,
            target: { assetId: entry.offer.assetId, assetRevision: entry.offer.assetRevision },
            exposureId: entry.exposureId,
          },
        };
      void runAction();
    },
    retryAction() {
      void runAction();
    },
    canBack: history.canBack,
    end,
  };
}
export type EncounterSession = ReturnType<typeof createEncounterSession>;
