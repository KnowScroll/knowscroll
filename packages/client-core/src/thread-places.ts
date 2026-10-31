import type { ContentThreadRef, ThreadPlace } from '@knowscroll/contracts';
import type { AccountScope } from './account-scope';
import { talkFailure } from './talk-failure';

const VERSION = 'content-thread.v1' as const;

/**
 * Where the members of a thread's series are, as this person may see it (D-065). A place is a part,
 * `on` or `finished`, and a day: never a time, a playhead or a branch.
 * - `unavailable`: the thread ended for this person; the screen says so elsewhere, here there is nothing to show.
 * - `failed`: the places could not be read. They are a nicety, so the thread goes on without them.
 */
export interface ThreadPlacesState {
  readonly phase: 'loading' | 'ready' | 'unavailable' | 'failed';
  /** This person's own "hide where I am" for this thread. */
  readonly hidden: boolean;
  /** Members who share, the person themself included while they do. */
  readonly places: readonly ThreadPlace[];
  /** Changing the switch is in flight. */
  readonly saving: boolean;
}

export interface ThreadPlacesController {
  readonly getState: () => ThreadPlacesState;
  readonly subscribe: (listener: () => void) => () => void;
  /** Reads the places afresh; called on open, on a hint, on focus and by the slow poll. */
  readonly load: () => Promise<void>;
  /**
   * Tells the thread where this person is, from the thread's own player: they opened a part, or finished
   * it. Nothing is sent while they hide, or when the thread already has them there or further on. It never
   * throws and never blocks the player: a lost report is sent again by the next load. While they hide the
   * place is kept in memory only, and sent when they show it again.
   */
  readonly report: (part: number, state: 'on' | 'finished') => Promise<void>;
  /** Hides or shows this person's place in this thread. Returns whether the server took it. */
  readonly setHidden: (hidden: boolean) => Promise<boolean>;
}

type Place = { readonly part: number; readonly state: 'on' | 'finished' };

const emptyState: ThreadPlacesState = { phase: 'loading', hidden: false, places: [], saving: false };

/** How far along a place is: finishing a part sits between being on it and being on the next. */
export const placeProgress = (place: { readonly part: number; readonly state: 'on' | 'finished' }): number =>
  place.part * 2 + (place.state === 'finished' ? 1 : 0);

/**
 * One thread's places. The server owns them; this holds the last read and sends only this person's own.
 * Nothing here is derived from what the person watched or read elsewhere: the thread's player calls
 * `report`, and nothing else does.
 */
export function createThreadPlaces(options: {
  readonly scope: AccountScope;
  readonly thread: ContentThreadRef;
  readonly newId: () => string;
}): ThreadPlacesController {
  const session = new ThreadPlacesSession(options);
  return {
    getState: () => session.getState(),
    subscribe: (listener) => session.subscribe(listener),
    load: () => session.load(),
    report: (part, state) => session.report(part, state),
    setHidden: (hidden) => session.setHidden(hidden),
  };
}

class ThreadPlacesSession {
  private state: ThreadPlacesState = emptyState;
  private readonly scope: AccountScope;
  private readonly thread: ContentThreadRef;
  private readonly newId: () => string;
  private readonly listeners = new Set<() => void>();
  /** The first load: a report waits for it, so it knows whether this person hides before it sends anything. */
  private firstLoad: Promise<void> | undefined;
  /**
   * The furthest place the thread's player has reported on this device, kept in memory only. It is what
   * is sent once the person shows their place again, and what is retried after a lost report.
   */
  private latest: Place | undefined;
  /** The furthest place this device has sent, so a repeated open sends nothing. */
  private sent = 0;
  /** The command of a hide change in flight or unknown, kept so a retry is the same command. */
  private hideIntent: { readonly hidden: boolean; readonly commandId: string } | undefined;

  constructor(options: { scope: AccountScope; thread: ContentThreadRef; newId: () => string }) {
    this.scope = options.scope;
    this.thread = options.thread;
    this.newId = options.newId;
  }

  getState(): ThreadPlacesState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private publish(patch: Partial<ThreadPlacesState>): void {
    if (!this.scope.active) return;
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  load(): Promise<void> {
    const loading = this.read().then(() => this.flush());
    this.firstLoad ??= loading;
    return loading;
  }

  private async read(): Promise<void> {
    try {
      const answer = await this.scope.api.threads.places({
        version: VERSION,
        readId: this.newId(),
        thread: this.thread,
      });
      if (answer.status === 'unavailable') this.publish({ phase: 'unavailable', places: [] });
      else this.publish({ phase: 'ready', hidden: answer.hidden, places: answer.places });
    } catch (error) {
      if (talkFailure(error) === 'ended') return;
      // Keep what was shown: a failed read of a nicety is not worth an error on the thread.
      if (this.state.phase === 'loading') this.publish({ phase: 'failed' });
    }
  }

  async report(part: number, state: 'on' | 'finished'): Promise<void> {
    const place = { part, state };
    if (this.latest === undefined || placeProgress(place) > placeProgress(this.latest)) this.latest = place;
    await (this.firstLoad ?? this.load());
    await this.flush();
  }

  /** Sends the latest reported place when the thread does not have this person there or further on, and they share. */
  private async flush(): Promise<void> {
    const latest = this.latest;
    if (latest === undefined || this.state.phase !== 'ready' || this.state.hidden) return;
    const own = this.state.places.find((candidate) => candidate.you);
    if (placeProgress(latest) <= Math.max(this.sent, own === undefined ? 0 : placeProgress(own))) return;
    this.sent = placeProgress(latest);
    try {
      await this.scope.api.threads.setPlace({
        version: VERSION,
        commandId: this.newId(),
        thread: this.thread,
        part: latest.part,
        state: latest.state,
      });
    } catch {
      // Not sent, or not known to be: the next open or poll sends it again under a new command.
      this.sent = 0;
      return;
    }
    await this.read();
  }

  async setHidden(hidden: boolean): Promise<boolean> {
    if (this.state.saving) return false;
    this.publish({ saving: true });
    // The command ID is kept for each wanted state: after an unknown outcome the retry is the same command.
    const intent = this.hideIntent?.hidden === hidden ? this.hideIntent : { hidden, commandId: this.newId() };
    this.hideIntent = intent;
    try {
      await this.scope.api.threads.setPlaceHidden({
        version: VERSION,
        commandId: intent.commandId,
        thread: this.thread,
        hidden,
      });
    } catch (error) {
      this.publish({ saving: false });
      if (talkFailure(error) === 'unavailable') this.hideIntent = undefined;
      return false;
    }
    this.hideIntent = undefined;
    // Hiding deleted the server's copy; showing again sends where this person last was, from memory.
    if (hidden) this.sent = 0;
    this.publish({ saving: false });
    await this.read();
    await this.flush();
    return true;
  }
}
