import type {
  RoomWatch,
  RoomWatchStrip,
  WatchLastOnStage,
  WatchReel,
  WatchSessionView,
  WatchStartBlock,
} from '@knowscroll/contracts';
import type { AccountScope } from './account-scope';
import { intentRunner } from './room-activity';
import { talkFailure } from './talk-failure';

const VERSION = 'rooms.v1' as const;

type WatchReady = Extract<RoomWatch, { status: 'ready' }>;

// --- The shared clock and the words (pure) ----------------------------------------------------

/**
 * Where the shared clock is for a session view, in milliseconds from the Reel's first frame: negative while the session is still
 * starting. A view carries the time on the *server's* clock, never a time of day, so a device that is fast, slow or set to another
 * zone counts the same milliseconds. `sinceReadMs` is how long ago the view arrived, from a monotonic source. This is the only place
 * a device's position comes from: it is never read from, sent to or stored for anyone else (D-256).
 */
export function clockMs(session: WatchSessionView, sinceReadMs: number): number {
  const since = Math.max(0, sinceReadMs);
  return session.phase === 'starting' ? -session.startsInMs + since : session.elapsedMs + since;
}

/** What the session is doing by that clock: starting, playing, or over (the Reel has run out). */
export function watchPhaseNow(session: WatchSessionView, sinceReadMs: number): 'starting' | 'playing' | 'over' {
  const at = clockMs(session, sinceReadMs);
  if (at < 0) return 'starting';
  return at >= session.reel.durationMs ? 'over' : 'playing';
}

/**
 * How long until the screen should read the stage again by itself: when the phase it shows ends, plus a short beat so the server's clock
 * is surely past it. A device clock decides nothing here; the read decides what is next. `undefined` when there is no session.
 */
export function msUntilNextWatchRead(session: WatchSessionView | undefined, sinceReadMs: number): number | undefined {
  if (session === undefined) return undefined;
  const at = clockMs(session, sinceReadMs);
  const phaseEnds = at < 0 ? -at : session.reel.durationMs - at;
  return Math.max(0, phaseEnds) + 150;
}

/** How far the player may be from the shared clock before it is moved: below this, nobody can tell. */
export const SYNC_TOLERANCE_MS = 1_500;

/**
 * Whether this device's player should jump to follow the clock, and by how many seconds (negative: back). `undefined` while it is within
 * `SYNC_TOLERANCE_MS` of the clock, so a player that is keeping time is never nudged. The device's own position is read from its own
 * player and compared here; it goes nowhere.
 */
export function syncSeekSeconds(playerMs: number, shared: number): number | undefined {
  const drift = shared - playerMs;
  return Math.abs(drift) <= SYNC_TOLERANCE_MS ? undefined : drift / 1000;
}

/** A length of time as the stage draws it: "1:10". Rounded down to the second. */
export function clockWords(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, '0')}`;
}

/** The line under the picture (R3 A2): "0:41 / 1:10 · synced for everyone". Before the first frame it says how long. */
export function positionWords(session: WatchSessionView, sinceReadMs: number): string {
  const at = clockMs(session, sinceReadMs);
  if (at < 0) return `Starting in ${String(Math.ceil(-at / 1000))} s`;
  const position = Math.min(at, session.reel.durationMs);
  return `${clockWords(position)} / ${clockWords(session.reel.durationMs)} · synced for everyone`;
}

/** "4 watching": only a view that carries the number (from three people who joined) says anything. */
export const watchingLine = (session: WatchSessionView): string | undefined =>
  session.watching === undefined ? undefined : `${String(session.watching)} watching`;

/** Why a Reel cannot be started now, in words for the person who tapped Start. */
export const WATCH_START_BLOCK_WORDS: Record<WatchStartBlock, string> = {
  no_reels: 'This room has no Reel to watch together yet.',
  few_here: 'Watching together needs two people with the room open.',
  stage_busy: 'Something else is on the stage right now.',
  too_many: 'This room has watched a lot today. Try again tomorrow.',
  room_paused: 'This room is paused.',
};

/**
 * What the Now strip's chip says: a Reel can be watched together. While one is on, the stage is already above the conversation and the
 * band says so, so the chip has nothing to add and is not drawn.
 */
export function watchChip(
  strip: RoomWatchStrip | undefined,
): { readonly label: string; readonly detail: string } | undefined {
  return strip?.state === 'ready' ? { label: 'Watch together', detail: 'Start a Reel' } : undefined;
}

/**
 * "Last on stage: the Launch, yesterday at 21:30" (R3 A2 "Nothing live"). The day is read against `now` in `timeZone` (the device's
 * own by default) so it says "today" or "yesterday" when it can.
 */
export function lastOnStageWords(last: WatchLastOnStage | undefined, now: Date, timeZone?: string): string | undefined {
  if (last === undefined) return undefined;
  const what = last.kind === 'launch' ? 'the Launch' : 'a Reel together';
  const at = new Date(last.at);
  const zone = timeZone === undefined ? {} : { timeZone };
  const dayKey = (date: Date) => date.toLocaleDateString('en-CA', zone);
  const yesterday = new Date(now.getTime() - 24 * 3_600_000);
  const time = at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...zone });
  const day =
    dayKey(at) === dayKey(now)
      ? 'today'
      : dayKey(at) === dayKey(yesterday)
        ? 'yesterday'
        : at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...zone });
  return `Last on stage: ${what}, ${day} at ${time}`;
}

// --- The controller ---------------------------------------------------------------------------

type NotSaved = 'recording_paused' | 'recording_generation_stale';
type Acceptance =
  | { readonly outcome: 'accepted'; readonly sessionId: string }
  | { readonly outcome: 'not_saved'; readonly reason: NotSaved };
type PlayResult =
  | { readonly kind: 'accepted'; readonly sessionId: string }
  | { readonly kind: 'not_saved'; readonly reason: NotSaved }
  | { readonly kind: 'refused' | 'offline' | 'ended' };

export interface RoomWatchState {
  /** `unavailable`: not a member, or no such room; the screen says so without saying why. */
  readonly phase: 'loading' | 'ready' | 'unavailable' | 'failed';
  readonly view: WatchReady | undefined;
  /** A steady-clock reading (milliseconds) taken when `view` arrived, so the shared clock can be counted without the device's date. */
  readonly receivedAt: number;
  /** The Reels the room may watch, once the person opened the list; `undefined` until then. */
  readonly reels: readonly WatchReel[] | undefined;
  readonly reelsFailed: boolean;
  readonly offline: boolean;
  readonly working: boolean;
  /** The last command was refused (the session changed meanwhile); the screen has read the stage again and says so. */
  readonly refused: boolean;
  /**
   * The sessions this device's own person joined from this device, by session ID: set only when this device's Join (or Start) was
   * accepted, and dropped when a read says the person is no longer in, when they leave or when the session is over. The server's
   * `youIn` says the person is in from somewhere; only this says the Reel is to be opened **here**. So a second device, or a room
   * reopened while the person's place still stands, shows Join and opens nothing (D-258). It lives in the controller, which lives in
   * the account scope's screen, so an account switch ends it.
   */
  readonly joinedHere: readonly string[];
  /**
   * Recording is paused right now (D-057). Joining is kept in the room, so while it is true a person cannot join or start one: the
   * screen says so before any tap. Read from the person's own recording policy and kept fresh while a screen listens (D-258).
   */
  readonly recordingPaused: boolean;
  /** The last command was not kept: recording is paused or this device's settings were out of date. Nothing was stored. */
  readonly notSaved: NotSaved | undefined;
}

export interface RoomWatchController {
  readonly getState: () => RoomWatchState;
  readonly subscribe: (listener: () => void) => () => void;
  /** Reads the stage again: the session that is on, or whether one can be started. */
  readonly load: () => Promise<void>;
  /** Reads the Reels the room's topic rests on, for the picker. */
  readonly loadReels: () => Promise<void>;
  /** Starts Watch together on a library Reel and joins it, here; true when it began. While recording is paused nothing is sent. */
  readonly start: (assetId: string) => Promise<boolean>;
  /** Says the person is watching the session that is on, from this device. While recording is paused nothing is sent. */
  readonly join: () => Promise<boolean>;
  /** Leaves the stage: no longer counted, nothing of theirs kept. Always possible. */
  readonly leave: () => Promise<boolean>;
  /** Ends the session for everyone (the member who shared it, or a moderator). */
  readonly stop: () => Promise<boolean>;
}

export interface RoomWatchOptions {
  readonly scope: AccountScope;
  readonly roomId: string;
  readonly newId: () => string;
  /** A steady clock in milliseconds (never a date): `performance.now` in the app. */
  readonly clock: () => number;
}

const initial: RoomWatchState = {
  phase: 'loading',
  view: undefined,
  receivedAt: 0,
  reels: undefined,
  reelsFailed: false,
  offline: false,
  working: false,
  refused: false,
  joinedHere: [],
  recordingPaused: false,
  notSaved: undefined,
};

/**
 * One room's stage for a member. The server owns the clock and who joined: this keeps the last view it gave, when it arrived, the
 * command in flight and nothing else. It never holds, sends or asks for anyone's position: the screen works its own out from
 * `clockMs`. It reads again when a room hint arrives, on the slow poll and by itself when the phase it shows ends (the screen asks,
 * from `msUntilNextWatchRead`), so a lost hint costs a few seconds and never a wrong stage. Nothing here is observed or recorded as
 * watching: a person's own watch is the ordinary Reel encounter their own screen opens after they join.
 */
export function createRoomWatch(options: RoomWatchOptions): RoomWatchController {
  const { scope, roomId, newId, clock } = options;
  const listeners = new Set<() => void>();
  const run = intentRunner(newId);
  const paused = () => scope.recording?.getState().policy?.on === false;
  let state: RoomWatchState = { ...initial, recordingPaused: paused() };
  let stopWatching: (() => void) | undefined;
  const publish = (patch: Partial<RoomWatchState>): void => {
    if (!scope.active) return;
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  };

  async function load(): Promise<void> {
    try {
      const answer = await scope.api.rooms.watch({ version: VERSION, readId: newId(), roomId });
      if (answer.status === 'unavailable') publish({ phase: 'unavailable', view: undefined, offline: false });
      else {
        // Only a session this device joined, that the server still says the person is in, stays joined here.
        const session = answer.session;
        const joinedHere = state.joinedHere.filter((joined) => session?.sessionId === joined && session.youIn);
        publish({ phase: 'ready', view: answer, receivedAt: clock(), offline: false, joinedHere });
      }
    } catch (error) {
      const failure = talkFailure(error);
      if (failure === 'ended') return;
      if (failure === 'unavailable') publish({ phase: 'unavailable', view: undefined });
      else if (state.phase === 'loading') publish({ phase: 'failed', offline: failure === 'offline' });
      else publish({ offline: true });
    }
  }

  async function loadReels(): Promise<void> {
    try {
      const answer = await scope.api.rooms.watchReels({ version: VERSION, readId: newId(), roomId });
      publish({ reels: answer.status === 'ready' ? answer.reels : [], reelsFailed: false });
    } catch (error) {
      if (talkFailure(error) !== 'ended') publish({ reelsFailed: true });
    }
  }

  /** Sends one command that records the person in the room, with the recording generation; the server may answer `not_saved`. */
  async function play(
    intent: string,
    send: (commandId: string, recordingGeneration: number) => Promise<Acceptance>,
  ): Promise<PlayResult> {
    if (paused()) return { kind: 'not_saved', reason: 'recording_paused' };
    const outcome = await run(intent, async (commandId) => {
      const generation = await scope.recording?.generation();
      if (generation === undefined) throw new Error('recording_policy_unavailable');
      return send(commandId, generation);
    });
    if (outcome.kind !== 'ok') return { kind: outcome.kind };
    const acceptance = outcome.value;
    return acceptance.outcome === 'accepted'
      ? { kind: 'accepted', sessionId: acceptance.sessionId }
      : { kind: 'not_saved', reason: acceptance.reason };
  }

  /** What a command that did not succeed comes to for the screen: a refusal reads the stage again, a `not_saved` says so and reads the policy. */
  async function settleFailure(result: Exclude<PlayResult, { kind: 'accepted' }>): Promise<false> {
    publish({ working: false });
    if (result.kind === 'offline') publish({ offline: true });
    else if (result.kind === 'refused') {
      publish({ refused: true });
      await load();
    } else if (result.kind === 'not_saved') {
      publish({ notSaved: result.reason });
      await scope.recording?.refresh();
    }
    return false;
  }

  /** Leave and stop remove what is stored, so they never wait on the recording policy. */
  async function undo(
    intent: string,
    sessionId: string,
    send: (commandId: string) => Promise<unknown>,
  ): Promise<boolean> {
    if (state.working) return false;
    publish({ working: true, refused: false, notSaved: undefined });
    const outcome = await run(intent, send);
    if (outcome.kind !== 'ok') return settleFailure({ kind: outcome.kind });
    publish({ working: false, joinedHere: state.joinedHere.filter((joined) => joined !== sessionId) });
    await load();
    return true;
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      // While a screen listens, the policy is watched, so a pause or a resume shows at once.
      if (listeners.size === 1)
        stopWatching = scope.recording?.subscribe(() => {
          if (paused() !== state.recordingPaused) publish({ recordingPaused: paused() });
        });
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          stopWatching?.();
          stopWatching = undefined;
        }
      };
    },
    load,
    loadReels,

    async start(assetId) {
      if (state.working) return false;
      publish({ working: true, refused: false, notSaved: undefined });
      const result = await play(`start:${assetId}`, (commandId, recordingGeneration) =>
        scope.api.rooms.startWatch({ version: VERSION, commandId, roomId, assetId, recordingGeneration }),
      );
      if (result.kind !== 'accepted') return settleFailure(result);
      publish({ working: false, joinedHere: [...state.joinedHere, result.sessionId] });
      await load();
      return true;
    },

    async join() {
      const session = state.view?.session;
      if (session === undefined || state.working) return false;
      publish({ working: true, refused: false, notSaved: undefined });
      const result = await play(`join:${session.sessionId}`, (commandId, recordingGeneration) =>
        scope.api.rooms.joinWatch({
          version: VERSION,
          commandId,
          roomId,
          sessionId: session.sessionId,
          recordingGeneration,
        }),
      );
      if (result.kind !== 'accepted') return settleFailure(result);
      publish({ working: false, joinedHere: [...state.joinedHere, result.sessionId] });
      await load();
      return true;
    },

    async leave() {
      const session = state.view?.session;
      if (session === undefined) return false;
      return undo(`leave:${session.sessionId}`, session.sessionId, (commandId) =>
        scope.api.rooms.leaveWatch({ version: VERSION, commandId, roomId, sessionId: session.sessionId }),
      );
    },

    async stop() {
      const session = state.view?.session;
      if (session === undefined) return false;
      return undo(`stop:${session.sessionId}`, session.sessionId, (commandId) =>
        scope.api.rooms.stopWatch({ version: VERSION, commandId, roomId, sessionId: session.sessionId }),
      );
    },
  };
}
