/**
 * The reader state machine. A plain, framework-independent class (mirroring
 * apps/mobile/.../ui/AppViewModel.kt, scoped to this slice: no Ask, Reel,
 * Friends, branch, Clear History or sign-out control exists here per #92).
 *
 * A React hook subscribes via useSyncExternalStore (src/hooks/useReaderStore.ts);
 * this file has no DOM/React dependency so its logic is directly unit-testable.
 */
import { ApiException, describeApiError, invalidatesReader, isUnauthorized, type ReaderApi } from '../api/client.ts';
import type { EventStatus, FeedItem, FeedResponse, Trace, TraceRevisit, Universe } from '../api/types.ts';
import { canRequestDiscovery, selectDiscovery, type DiscoveryState, type KeepState } from './discovery.ts';
import type { ReaderStorage, RevisitSession, ScrollSession } from './storage.ts';

function randomUuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  // Deterministic-shape fallback for non-secure/older test contexts only.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export type ReaderOrigin = { type: 'discovery' } | { type: 'saved-trace'; eventId: string };

export type UniverseView =
  | { status: 'loading' }
  | { status: 'loaded'; universe: Universe }
  | { status: 'unavailable'; message: string };

export type ScrollView =
  | { status: 'idle' }
  | { status: 'loading' }
  | {
      status: 'reading';
      item: FeedItem;
      exposureId: string;
      eventId: string;
      keep: KeepState;
      readingPosition: number;
      discovery: DiscoveryState;
      origin: ReaderOrigin;
    }
  | { status: 'unavailable'; message: string; retryable: boolean }
  | { status: 'exhausted' };

export type Screen = 'universe' | 'scroll' | 'revisit';

export interface ReaderState {
  screen: Screen;
  universe: UniverseView;
  scroll: ScrollView;
  toast: string | null;
}

type Listener = () => void;

export class ReaderStore {
  private state: ReaderState = {
    screen: 'universe',
    universe: { status: 'loading' },
    scroll: { status: 'idle' },
    toast: null,
  };
  private readonly listeners = new Set<Listener>();
  private session: ScrollSession | null = null;
  private revisit: RevisitSession | null = null;
  private observedPrivacyEpoch: number;
  private observedUniverseId: string;
  private busy = false;
  private reconciling = false;
  private ready = false;
  private navigationVersion = 0;
  private readonly visited: Set<string>;

  constructor(private readonly api: ReaderApi, private readonly storage: ReaderStorage) {
    this.observedPrivacyEpoch = storage.readObservedPrivacyEpoch();
    this.observedUniverseId = storage.readObservedUniverseId();
    this.visited = storage.readVisited();
  }

  getState(): ReaderState {
    return this.state;
  }
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private set(patch: Partial<ReaderState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  consumeToast(): void {
    if (this.state.toast !== null) this.set({ toast: null });
  }

  init(): void {
    this.reconcilePrivacy(true);
  }

  retryUniverse(): void {
    this.reconcilePrivacy(this.storage.readScreen() === 'scroll' || this.storage.readScreen() === 'revisit');
  }

  retryScrollLoad(): void {
    const pending = this.revisit;
    if (this.state.screen === 'revisit' && pending) {
      this.loadTraceRevisit(pending);
    } else if (this.state.screen === 'revisit') {
      return;
    } else {
      this.enterScroll();
    }
  }

  enterScroll(): void {
    if (this.busy || this.reconciling || !this.ready) return;
    const current = this.session;
    if (current && current.keepJobId === '' && current.privacyEpoch === this.observedPrivacyEpoch) {
      this.show(current);
      return;
    }
    this.loadNext();
  }

  /** A Trace has an explicit origin and never becomes a new discovery or exposure (docs/contracts/trace-revisit.md). */
  openTrace(trace: Trace): void {
    if (this.busy || this.reconciling || !this.ready) return;
    const requested: RevisitSession = {
      eventId: trace.eventId,
      assetId: trace.assetId,
      privacyEpoch: this.observedPrivacyEpoch,
      universeId: this.observedUniverseId,
      readingPosition: 0,
    };
    this.revisit = requested;
    this.storage.writeRevisit(requested);
    this.loadTraceRevisit(requested);
  }

  private loadTraceRevisit(requested: RevisitSession, restoring = false): void {
    if (this.busy || (!restoring && this.reconciling) || !this.ready) return;
    if (requested.privacyEpoch !== this.observedPrivacyEpoch || requested.universeId !== this.observedUniverseId) {
      this.discardRevisit();
      return;
    }
    this.busy = true;
    const version = ++this.navigationVersion;
    const epoch = this.observedPrivacyEpoch;
    this.storage.writeScreen('revisit');
    this.set({ screen: 'revisit', scroll: { status: 'loading' } });
    this.api
      .getTraceRevisit(requested.eventId)
      .then(receipt => {
        if (!this.operationIsCurrent(version, epoch)) return;
        const accepted = acceptTraceRevisit(receipt, requested);
        if (!accepted) {
          this.discardRevisit();
          this.set({ scroll: { status: 'unavailable', message: 'This saved Scroll could not be verified.', retryable: false } });
          return;
        }
        this.revisit = accepted;
        this.storage.writeRevisit(accepted);
        this.set({
          scroll: {
            status: 'reading',
            // The revisit contract deliberately returns no recommendation `reason`
            // (docs/contracts/trace-revisit.md): "may not invent selection personalization".
            item: { ...receipt.scroll, reason: '' },
            exposureId: receipt.exposureId,
            eventId: requested.eventId,
            keep: { status: 'kept', jobId: requested.eventId },
            readingPosition: accepted.readingPosition,
            discovery: 'idle',
            origin: { type: 'saved-trace', eventId: requested.eventId },
          },
        });
      })
      .catch((error: unknown) => {
        if (version !== this.navigationVersion || this.state.screen !== 'revisit') return;
        if (error instanceof ApiException && error.error.kind === 'server' && error.error.statusCode === 409) {
          this.discardRevisit();
          this.set({ scroll: { status: 'unavailable', message: "This saved Scroll's source has changed and cannot be reopened.", retryable: false } });
        } else if (
          error instanceof ApiException &&
          (error.error.kind === 'protocol' || (error.error.kind === 'server' && [400, 404, 422].includes(error.error.statusCode)))
        ) {
          this.discardRevisit();
          this.set({ scroll: { status: 'unavailable', message: 'This saved Scroll is unavailable.', retryable: false } });
        } else if (invalidatesReader(error)) {
          this.purgeForScope(requested.universeId, epoch);
          this.failClosed(describeApiError(error));
        } else {
          this.set({ scroll: { status: 'unavailable', message: describeApiError(error), retryable: true } });
        }
      })
      .finally(() => {
        if (version === this.navigationVersion) this.busy = false;
      });
  }

  nextScroll(): void {
    const reading = this.state.scroll.status === 'reading' ? this.state.scroll : null;
    if (!reading) return;
    if (!this.busy && !this.reconciling && this.ready && canRequestDiscovery(reading.keep, reading.discovery)) {
      this.loadNext(true);
    }
  }

  private loadNext(preserveReading = false): void {
    if (this.busy || this.reconciling || !this.ready) return;
    const reading = preserveReading && this.state.scroll.status === 'reading' ? this.state.scroll : null;
    this.busy = true;
    const version = ++this.navigationVersion;
    const epoch = this.observedPrivacyEpoch;
    const universeId = this.observedUniverseId;
    if (reading) {
      this.set({ scroll: { ...reading, discovery: 'loading' } });
    } else {
      this.storage.writeScreen('scroll');
      this.set({ screen: 'scroll', scroll: { status: 'loading' } });
    }
    this.api
      .getFeed()
      .then((feed: FeedResponse) => {
        if (!this.operationIsCurrent(version, epoch)) return;
        const currentAssetId = reading?.item.assetId ?? this.session?.item.assetId;
        const selection = selectDiscovery(feed, universeId, epoch, this.visited, currentAssetId);
        if (selection.kind === 'invalid-scope') {
          this.purgeForScope(feed.universeId, feed.privacyEpoch);
          this.failClosed('Your session moved to a different universe or privacy state. Reconnect to continue.');
        } else if (selection.kind === 'exhausted') {
          if (reading) {
            const current = this.state.scroll;
            if (current.status === 'reading') this.set({ scroll: { ...current, discovery: 'exhausted' } });
          } else {
            this.set({ scroll: { status: 'exhausted' } });
          }
        } else {
          const next: ScrollSession = {
            decisionId: feed.decisionId,
            item: selection.item,
            privacyEpoch: feed.privacyEpoch,
            universeId: feed.universeId,
            clientExposureId: randomUuid(),
            clientEventId: randomUuid(),
            exposureId: '',
            exposureEventId: '',
            keepJobId: '',
            keepEventId: '',
            readingPosition: 0,
          };
          if (this.session) {
            this.visited.add(this.session.item.assetId);
            this.storage.writeVisited(this.visited);
          }
          this.discardRevisit();
          this.storage.writeSession(next);
          this.session = next;
          this.show(next);
        }
      })
      .catch((error: unknown) => {
        if (version !== this.navigationVersion || (this.state.screen !== 'scroll' && this.state.screen !== 'revisit')) return;
        if (invalidatesReader(error)) {
          this.purgeForScope(universeId, epoch);
          this.failClosed(describeApiError(error));
        } else if (reading) {
          const current = this.state.scroll;
          if (current.status === 'reading') this.set({ scroll: { ...current, discovery: 'failed' } });
        } else {
          this.set({ scroll: { status: 'unavailable', message: describeApiError(error), retryable: true } });
        }
      })
      .finally(() => {
        if (version === this.navigationVersion) this.busy = false;
      });
  }

  private show(value: ScrollSession): void {
    if (value.privacyEpoch !== this.observedPrivacyEpoch || value.universeId !== this.observedUniverseId) return;
    this.storage.writeScreen('scroll');
    this.set({
      screen: 'scroll',
      scroll: {
        status: 'reading',
        item: value.item,
        exposureId: value.exposureId,
        eventId: value.exposureEventId,
        keep: value.keepJobId === '' ? { status: 'idle' } : { status: 'kept', jobId: value.keepJobId },
        readingPosition: value.readingPosition,
        discovery: 'idle',
        origin: { type: 'discovery' },
      },
    });
  }

  /** Called by the visibility/intersection hook after the Scroll is actually rendered on screen. */
  onVisible(assetId: string): void {
    if (this.state.screen === 'revisit') return;
    const current = this.session;
    if (!current || current.item.assetId !== assetId || current.exposureId !== '' || this.busy || !this.ready) return;
    const version = this.navigationVersion;
    const epoch = this.observedPrivacyEpoch;
    this.busy = true;
    this.recordExposure(current, version, epoch)
      .then(next => {
        if (this.operationIsCurrent(version, epoch, next)) {
          this.session = next;
          this.show(next);
        }
      })
      .catch((error: unknown) => {
        if (version !== this.navigationVersion) return;
        if (invalidatesReader(error)) {
          this.purgeForScope(current.universeId, epoch);
          this.failClosed(describeApiError(error));
        } else {
          this.set({ toast: describeApiError(error) });
        }
      })
      .finally(() => {
        if (version === this.navigationVersion) this.busy = false;
      });
  }

  private async recordExposure(value: ScrollSession, version: number, epoch: number): Promise<ScrollSession> {
    if (value.exposureId !== '') return value;
    const receipt = await this.api.postExposure({ decisionId: value.decisionId, assetId: value.item.assetId, clientExposureId: value.clientExposureId });
    if (!this.operationIsCurrent(version, epoch, value)) throw new StaleOperationError();
    const latest =
      this.session && this.session.clientExposureId === value.clientExposureId && this.session.item.assetId === value.item.assetId
        ? this.session
        : value;
    const updated: ScrollSession = { ...latest, exposureId: receipt.exposureId, exposureEventId: receipt.eventId };
    if (!this.operationIsCurrent(version, epoch, value)) throw new StaleOperationError();
    this.storage.writeSession(updated);
    return updated;
  }

  keep(): void {
    if (this.busy || !this.ready) return;
    if (this.state.scroll.status === 'reading' && this.state.scroll.origin.type === 'saved-trace') return;
    const currentSession = this.session;
    if (!currentSession || currentSession.keepJobId !== '') return;
    const currentState = this.state.scroll;
    if (currentState.status !== 'reading') return;
    this.busy = true;
    const version = this.navigationVersion;
    const epoch = this.observedPrivacyEpoch;
    this.set({ scroll: { ...currentState, keep: { status: 'saving' } } });
    this.recordExposure(currentSession, version, epoch)
      .then(exposed => {
        if (!this.operationIsCurrent(version, epoch, exposed)) return Promise.reject(new StaleOperationError());
        this.session = exposed;
        return this.api
          .postInteraction({ clientEventId: exposed.clientEventId, exposureId: exposed.exposureId, assetId: exposed.item.assetId, kind: 'keep' })
          .then(receipt => ({ exposed, receipt }));
      })
      .then(result => {
        if (!result) return;
        const { exposed, receipt } = result;
        if (!this.operationIsCurrent(version, epoch, exposed)) return;
        if (receipt.status !== 'accepted') throw new Error('Keep was not accepted');
        const latest = this.session && this.session.clientEventId === exposed.clientEventId && this.session.item.assetId === exposed.item.assetId ? this.session : exposed;
        const kept: ScrollSession = { ...latest, keepJobId: receipt.jobId, keepEventId: receipt.eventId };
        if (!this.operationIsCurrent(version, epoch, exposed)) return;
        this.storage.writeSession(kept);
        this.session = kept;
        this.show(kept);
        void this.pollProjection(receipt.eventId, version, epoch, kept);
      })
      .catch((error: unknown) => {
        if (error instanceof StaleOperationError) return;
        if (!this.operationIsCurrent(version, epoch, currentSession)) return;
        if (invalidatesReader(error)) {
          this.purgeForScope(currentSession.universeId, epoch);
          this.failClosed(describeApiError(error));
        } else {
          const current = this.state.scroll;
          if (current.status === 'reading') this.set({ scroll: { ...current, keep: { status: 'failed', message: describeApiError(error) } } });
        }
      })
      .finally(() => {
        if (version === this.navigationVersion) this.busy = false;
      });
  }

  /** Mirrors AppViewModel.kt: up to 20 polls at 250ms for the projection to land before quietly refreshing traces. */
  private async pollProjection(eventId: string, version: number, epoch: number, kept: ScrollSession): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt++) {
      await delay(250);
      if (!this.operationIsCurrent(version, epoch, kept)) return;
      const projected = await this.api
        .getEvent(eventId)
        .then((status: EventStatus) => status.projected)
        .catch(() => false);
      if (projected) {
        if (this.state.screen === 'universe') this.reconcilePrivacy(false);
        return;
      }
    }
  }

  updateReadingPosition(assetId: string, position: number): void {
    const reading = this.state.scroll.status === 'reading' ? this.state.scroll : null;
    if (reading?.origin.type === 'saved-trace') {
      const current = this.revisit;
      if (!current || reading.item.assetId !== assetId || current.assetId !== assetId || current.readingPosition === position || position < 0) return;
      const updated: RevisitSession = { ...current, readingPosition: position };
      this.revisit = updated;
      this.storage.writeRevisit(updated);
      this.set({ scroll: { ...reading, readingPosition: position } });
      return;
    }
    const current = this.session;
    if (!current || current.item.assetId !== assetId || current.readingPosition === position || current.privacyEpoch !== this.observedPrivacyEpoch) return;
    const updated: ScrollSession = { ...current, readingPosition: position };
    this.storage.writeReadingPosition(assetId, position);
    this.session = updated;
    if (reading?.item.assetId === assetId) this.set({ scroll: { ...reading, readingPosition: position } });
  }

  returnToUniverse(): void {
    this.navigationVersion++;
    if (this.state.screen === 'revisit') this.discardRevisit();
    this.visited.clear();
    this.storage.writeVisited(this.visited);
    this.storage.writeScreen('universe');
    this.set({ screen: 'universe', scroll: { status: 'idle' } });
    this.reconcilePrivacy(false);
  }

  private reconcilePrivacy(restoreStoredScroll: boolean): void {
    if (this.reconciling) return;
    this.reconciling = true;
    this.ready = false;
    this.busy = false;
    const version = ++this.navigationVersion;
    const storedScreen = this.storage.readScreen();
    const wantedScroll = restoreStoredScroll && storedScreen === 'scroll';
    const wantedRevisit = restoreStoredScroll && storedScreen === 'revisit';
    if (wantedScroll) this.set({ screen: 'scroll', scroll: { status: 'loading' } });
    else if (wantedRevisit) this.set({ screen: 'revisit', scroll: { status: 'loading' } });
    else this.set({ screen: 'universe', universe: { status: 'loading' } });
    this.api
      .getUniverse()
      .then(actual => {
        const localUniverse = this.storage.readObservedUniverseId();
        const bindingUnknown = localUniverse === '';
        const bindingChanged = localUniverse !== '' && localUniverse !== actual.universeId;
        if (bindingUnknown || bindingChanged) {
          this.purgeForScope(actual.universeId, actual.privacyEpoch);
          this.applyUniverse(actual, false, version);
        } else {
          this.applyUniverse(actual, wantedScroll || wantedRevisit, version);
        }
      })
      .catch((error: unknown) => {
        if (isUnauthorized(error) || invalidatesReader(error)) {
          const scope = this.revisit;
          this.purgeForScope(scope?.universeId || this.observedUniverseId, Math.max(this.observedPrivacyEpoch, scope?.privacyEpoch ?? 0));
        }
        this.failClosed(describeApiError(error));
      })
      .finally(() => {
        this.reconciling = false;
      });
  }

  private applyUniverse(actual: Universe, restoreStoredScroll: boolean, version: number): void {
    if (version !== this.navigationVersion) return;
    if (this.observedUniverseId !== '' && actual.universeId !== this.observedUniverseId) {
      this.purgeForScope(actual.universeId, actual.privacyEpoch);
    } else if (actual.privacyEpoch < this.observedPrivacyEpoch) {
      this.failClosed('The server returned an older privacy state. Reconnect before restoring Scroll history.');
      return;
    }
    if (actual.privacyEpoch > this.observedPrivacyEpoch) this.purgeForScope(actual.universeId, actual.privacyEpoch);
    this.observedUniverseId = actual.universeId;
    this.observedPrivacyEpoch = this.storage.observePrivacyState(actual.universeId, actual.privacyEpoch);
    this.ready = true;
    this.set({ universe: { status: 'loaded', universe: actual } });

    const cached = restoreStoredScroll && this.storage.readScreen() === 'scroll' ? this.storage.readSession() : null;
    const cachedRevisit = restoreStoredScroll && this.storage.readScreen() === 'revisit' ? this.storage.readRevisit() : null;
    if (cached && cached.privacyEpoch === this.observedPrivacyEpoch && cached.universeId === this.observedUniverseId) {
      this.session = cached;
      this.show(cached);
    } else if (cachedRevisit && cachedRevisit.privacyEpoch === this.observedPrivacyEpoch && cachedRevisit.universeId === this.observedUniverseId) {
      this.revisit = cachedRevisit;
      this.loadTraceRevisit(cachedRevisit, true);
    } else {
      if (cached || cachedRevisit || (restoreStoredScroll && this.storage.readScreen() === 'revisit')) this.purgeForScope(this.observedUniverseId, this.observedPrivacyEpoch);
      this.storage.writeScreen('universe');
      this.set({ screen: 'universe' });
    }
  }

  private purgeForScope(universeId: string, epoch: number): void {
    this.storage.purgePrivateState(universeId, epoch);
    this.observedUniverseId = this.storage.readObservedUniverseId();
    this.observedPrivacyEpoch = this.storage.readObservedPrivacyEpoch();
    this.session = null;
    this.revisit = null;
    this.visited.clear();
    this.set({ screen: 'universe', scroll: { status: 'idle' } });
  }

  private failClosed(reason: string): void {
    this.ready = false;
    this.session = null;
    this.set({ screen: 'universe', scroll: { status: 'idle' }, universe: { status: 'unavailable', message: reason } });
  }

  private discardRevisit(): void {
    this.revisit = null;
    this.storage.clearRevisit();
  }

  private operationIsCurrent(version: number, epoch: number, value?: ScrollSession): boolean {
    if (version !== this.navigationVersion || epoch !== this.observedPrivacyEpoch) return false;
    if (value) {
      const current = this.session;
      if (!current || current.clientEventId !== value.clientEventId || current.item.assetId !== value.item.assetId || current.universeId !== this.observedUniverseId) return false;
    }
    return true;
  }
}

class StaleOperationError extends Error {
  constructor() {
    super('Stale operation superseded by a newer navigation');
  }
}

/** Refuse a response that cannot be tied back to the Trace card and reconciled scope. */
export function acceptTraceRevisit(receipt: TraceRevisit, requested: RevisitSession): RevisitSession | null {
  if (
    receipt.traceEventId !== requested.eventId ||
    receipt.universeId !== requested.universeId ||
    receipt.privacyEpoch !== requested.privacyEpoch ||
    receipt.scroll.assetId !== requested.assetId ||
    receipt.exposureId === '' ||
    receipt.scroll.kind !== 'Scroll' ||
    receipt.scroll.truthState !== 'documented' ||
    receipt.scroll.revision <= 0 ||
    (requested.revision !== undefined && requested.revision !== receipt.scroll.revision)
  ) {
    return null;
  }
  return { ...requested, revision: receipt.scroll.revision };
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
