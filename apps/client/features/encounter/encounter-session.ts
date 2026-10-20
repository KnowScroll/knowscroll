import {
  apiProblem,
  createReelRecorder,
  createScrollRecorder,
  ScopeEndedError,
  type AccountScope,
} from '@knowscroll/client-core';
import type {
  ApplyActionRequest,
  EncounterOffer,
  ExposureContextResponse,
  NavigateExperienceRequest,
  NavigationOutcome,
} from '@knowscroll/contracts';
import { parseDocument } from '@knowscroll/scroll-model';
import type { EncounterGestureMove } from './gestures/arbitration';
import { ENCOUNTER_CAPABILITIES } from './capabilities';
import { createEncounterHistory, readResume, type EncounterEntry } from './encounter-history';

export type EncounterPhase =
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
  readonly surfaceRevision: number;
  readonly contextReady?: boolean;
}
type Intent = NavigateExperienceRequest['intent'];
type OfferActivation = Extract<
  Awaited<ReturnType<AccountScope['api']['experience']['activateExposure']>>,
  { sessionId: string }
>;
interface Work {
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
      position: readResume(scope, offer.assetId, offer.assetRevision),
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
      if (!current.outcome) {
        publish({ phase: 'opening', actionFailed: false });
        current.outcome = await current.command();
        if (!valid() || work !== current) return;
        latest(current.outcome);
      }
      const outcome = current.outcome;
      if (outcome.status !== 'ready') {
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
      history.push(current.entry);
      work = undefined;
      publish({ phase: 'active', outcome: undefined });
    } catch (error) {
      fail(error);
    } finally {
      busy = false;
    }
  }
  const begin = (command: () => Promise<NavigationOutcome>) => {
    if (!valid() || work || busy || actionRunning) return;
    work = { command, activateId: newId() };
    void run();
  };
  const open = (target: { kind: 'discover' } | { kind: 'return'; assetId: string; assetRevision: number }) => {
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
    });
    return true;
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
    navigate,
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
      if (returning) {
        const entry = history.current();
        if (entry?.started) entry.restored = true;
        publish({ surfaceRevision: state.surfaceRevision + 1 });
      }
      if (!value) history.park();
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
      if (!entry || history.current() === entry) history.park();
    },
    done() {
      history.park();
      publish({ phase: 'exhausted', outcome: undefined, overlay: false });
    },
    back() {
      if (!valid()) return false;
      if (state.overlay) {
        const entry = history.current();
        if (entry) entry.restored = true;
        publish({ overlay: false, surfaceRevision: state.surfaceRevision + 1 });
        return true;
      }
      if (work || busy) return false;
      if (!history.back()) return false;
      contextSerial += 1;
      // No read, command, activation, or new recorder on Back. Latest server intent remains independent.
      publish({ phase: 'active', outcome: undefined });
      return true;
    },
    restore(exposureId: string) {
      if (work || busy || !history.restore(exposureId)) return;
      contextSerial += 1;
      publish({ phase: 'active', outcome: undefined, overlay: false });
    },
    setOverlay(overlay: boolean) {
      if (overlay) history.park();
      else {
        const entry = history.current();
        if (entry) entry.restored = true;
      }
      publish({ overlay, surfaceRevision: state.surfaceRevision + (overlay ? 0 : 1) });
    },
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
