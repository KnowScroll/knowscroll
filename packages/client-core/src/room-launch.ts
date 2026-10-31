import {
  LAUNCH_QUESTIONS,
  type LaunchHost,
  type LaunchStartBlock,
  type LaunchView,
  type RoomLaunch,
  type RoomLaunchStrip,
} from '@knowscroll/contracts';
import type { AccountScope } from './account-scope';
import { intentRunner } from './room-activity';
import { talkFailure } from './talk-failure';

const VERSION = 'rooms.v1' as const;

type LaunchReady = Extract<RoomLaunch, { status: 'ready' }>;

// --- Words and time (pure) --------------------------------------------------------------------

/** The phase the server named, for a switch that does not need the rest of the view. */
export type LaunchPhase = LaunchView['phase'];

/**
 * How long is left of the phase a view describes, in milliseconds, by this device's own steady clock since the view arrived. A view
 * carries the time left on the *server's* clock, never a time of day, so a device that is fast, slow or set to another zone counts
 * the same seconds. `elapsedMs` is how long ago the view arrived, from a monotonic source. `undefined` for a podium: nothing counts down.
 */
export function timeLeftMs(view: LaunchView, elapsedMs: number): number | undefined {
  const left = (ms: number) => Math.max(0, ms - elapsedMs);
  switch (view.phase) {
    case 'lobby':
      return left(view.startsInMs);
    case 'open':
      return left(view.closesInMs);
    case 'reveal':
      return left(view.nextInMs);
    case 'finished':
      return undefined;
  }
}

/** Whole seconds for a countdown, rounded up so it reads "8 s" until it is over and "0 s" never while time remains. */
export const secondsLeft = (ms: number): number => Math.ceil(ms / 1000);

/**
 * How long until the screen should read the Launch again by itself: when the phase it shows ends, plus a short beat so the server's
 * clock is surely past it. A person's own clock decides nothing here; the read decides what is next. `undefined` when nothing changes
 * by itself (no Launch, or its podium).
 */
export function msUntilNextRead(view: LaunchView | undefined, elapsedMs: number): number | undefined {
  if (view === undefined) return undefined;
  const left = timeLeftMs(view, elapsedMs);
  return left === undefined ? undefined : left + 150;
}

/** One square for each question: right or not. Never an answer. */
export const squaresOf = (squares: readonly boolean[]): string => squares.map((right) => (right ? '■' : '□')).join('');

/**
 * The share card as text (R3 E): the room, the day, how many were right and a row of squares, with no question and no answer in it,
 * so it cannot spoil the Launch for anyone. `when` is the day as the screen writes it ("26 Oct").
 */
export function launchShareText(input: {
  readonly roomName: string;
  readonly when: string;
  readonly squares: readonly boolean[];
}): string {
  const score = input.squares.filter(Boolean).length;
  return `${input.roomName} · Launch ${input.when} · ${String(score)}/${String(input.squares.length)}\n${squaresOf(input.squares)}`;
}

/** The day of a Launch as a short date for the card: "26 Oct". Read in UTC, as the Launch's day is. */
export function launchDayWords(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${String(date.getUTCDate())} ${months[date.getUTCMonth()]!}`;
}

/**
 * What the host says, in template words that depend only on the state of the game (D-219). The host is labelled as AI and speaks
 * no model text: there is no call behind any of it. Each line is short, counts the player in and never mentions a wrong answer.
 */
export function hostLine(view: LaunchView, host: Pick<LaunchHost, 'name'>): string {
  switch (view.phase) {
    case 'lobby':
      return view.youIn
        ? `${host.name} here. You’re in. We start when the clock runs out.`
        : `${host.name} here. Five questions, eight seconds each. Join to play.`;
    case 'open':
      return view.round === 1
        ? `Question one. Eight seconds, go.`
        : view.round === LAUNCH_QUESTIONS
          ? 'Last question. Go.'
          : `Question ${wordsOfRound(view.round)}. Go.`;
    case 'reveal':
      if (view.last) return 'That’s the Launch. Podium next.';
      if (view.yourChoice === undefined)
        return view.youIn ? 'Time’s up on that one. Next question coming.' : 'Next question coming.';
      return view.yourChoice === view.correct ? 'Called it!' : 'Plot twist. On to the next one.';
    case 'finished':
      return view.youIn ? 'That’s the Launch. Thanks for playing.' : 'That was the Launch. Join the next one.';
  }
}

const ROUND_WORDS = ['one', 'two', 'three', 'four', 'five'] as const;
const wordsOfRound = (round: number): string => ROUND_WORDS[round - 1] ?? String(round);

/** Why a Launch cannot be started now, in words for the person who tapped Start. */
export const START_BLOCK_WORDS: Record<LaunchStartBlock, string> = {
  no_deck: 'No questions are ready for this room tonight.',
  few_here: 'A Launch needs two people with the room open.',
  resting: 'This room just had a Launch. Another one can start a little later.',
  room_paused: 'This room is paused.',
};

/**
 * The Launch's word for the Now strip and the band: what the screen last read of the Launch itself when it has read one, and
 * otherwise the room view's word. The room view is read less often than a Launch moves, so its word can be a phase behind.
 */
export function launchStripOf(
  launch: LaunchView | undefined,
  fallback: RoomLaunchStrip | undefined,
): RoomLaunchStrip | undefined {
  if (launch === undefined) return fallback;
  return { state: launch.phase === 'lobby' ? 'lobby' : launch.phase === 'finished' ? 'finished' : 'live' };
}

/** What the Now strip's chip says and does for each state of the room's Launch. */
export function launchChip(
  strip: RoomLaunchStrip | undefined,
): { readonly label: string; readonly detail: string; readonly live: boolean } | undefined {
  switch (strip?.state) {
    case undefined:
      return undefined;
    case 'ready':
      return { label: 'Launch', detail: 'Start a quiz', live: false };
    case 'lobby':
      return { label: 'Launch', detail: 'Starting now · join', live: true };
    case 'live':
      return { label: 'Launch', detail: 'Live now', live: true };
    case 'finished':
      return { label: 'Launch', detail: 'Podium', live: false };
  }
}

// --- The controller ---------------------------------------------------------------------------

type NotSaved = 'recording_paused' | 'recording_generation_stale';
type Acceptance = { readonly outcome: 'accepted' } | { readonly outcome: 'not_saved'; readonly reason: NotSaved };
type PlayResult =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'not_saved'; readonly reason: NotSaved }
  | { readonly kind: 'refused' | 'offline' | 'ended' };

export interface RoomLaunchState {
  /** `unavailable`: not a member, or no such room; the screen says so without saying why. */
  readonly phase: 'loading' | 'ready' | 'unavailable' | 'failed';
  readonly view: LaunchReady | undefined;
  /** A steady-clock reading (milliseconds) taken when `view` arrived, so time left can be counted without the device's date. */
  readonly receivedAt: number;
  readonly offline: boolean;
  readonly working: boolean;
  /** The last command was refused (too late, or the Launch changed meanwhile); the screen reads the Launch again and says so. */
  readonly refused: boolean;
  /**
   * Recording is paused right now (D-057). A Launch keeps each answer, so while it is true nothing can be played: the screen says so
   * before any tap and offers no Start, Join or answer. Read from the person's own recording policy and kept fresh while a screen listens.
   */
  readonly recordingPaused: boolean;
  /** The last command was not kept: recording is paused or this device's settings were out of date (D-220). Nothing was stored. */
  readonly notSaved: 'recording_paused' | 'recording_generation_stale' | undefined;
}

export interface RoomLaunchController {
  readonly getState: () => RoomLaunchState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly load: () => Promise<void>;
  /** Starts a Launch; true when it began. While recording is paused nothing is sent. */
  readonly start: () => Promise<boolean>;
  /** Says the person is in. */
  readonly join: () => Promise<boolean>;
  /**
   * Answers the open question with the option at `choice`. The choice shows at once and is sent with the Launch and round it was made
   * in; the server's clock decides whether it was in time. The first answer to a round stands: a second tap changes nothing.
   */
  readonly answer: (choice: number) => Promise<boolean>;
}

export interface RoomLaunchOptions {
  readonly scope: AccountScope;
  readonly roomId: string;
  readonly newId: () => string;
  /** A steady clock in milliseconds (never a date): `performance.now` in the app. */
  readonly clock: () => number;
}

const initial: RoomLaunchState = {
  phase: 'loading',
  view: undefined,
  receivedAt: 0,
  offline: false,
  working: false,
  refused: false,
  notSaved: undefined,
  recordingPaused: false,
};

/**
 * One room's Launch for a member. The server owns the clock and every answer: this keeps the last view it gave, when it arrived, the
 * command in flight and nothing else. It reads again by itself only when the phase it shows has ended (the screen asks, from
 * `msUntilNextRead`), when a room hint arrives and on the slow poll, so the screen is never ahead of the server. When a read finds the
 * Launch over, this device says so once (`finish`), which settles the room's star; every device may, and the server settles it once.
 * Nothing here is observed or recorded as reading.
 */
export function createRoomLaunch(options: RoomLaunchOptions): RoomLaunchController {
  const { scope, roomId, newId, clock } = options;
  const listeners = new Set<() => void>();
  const run = intentRunner(newId);
  const paused = () => scope.recording?.getState().policy?.on === false;
  let state: RoomLaunchState = { ...initial, recordingPaused: paused() };
  let settledFor: string | undefined;
  let stopWatching: (() => void) | undefined;
  const publish = (patch: Partial<RoomLaunchState>): void => {
    if (!scope.active) return;
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  };
  async function read(): Promise<void> {
    try {
      const answer = await scope.api.rooms.launch({ version: VERSION, readId: newId(), roomId });
      if (answer.status === 'unavailable') publish({ phase: 'unavailable', view: undefined, offline: false });
      else publish({ phase: 'ready', view: answer, receivedAt: clock(), offline: false });
    } catch (error) {
      const failure = talkFailure(error);
      if (failure === 'ended') return;
      if (failure === 'unavailable') publish({ phase: 'unavailable', view: undefined });
      else if (state.phase === 'loading') publish({ phase: 'failed', offline: failure === 'offline' });
      else publish({ offline: true });
    }
  }

  /** The Launch is over: tell the server once so it settles (the star), then read the podium again. */
  async function settle(): Promise<void> {
    const launch = state.view?.launch;
    if (launch?.phase !== 'finished' || settledFor === launch.launchId) return;
    settledFor = launch.launchId;
    const outcome = await run(`finish:${launch.launchId}`, (commandId) =>
      scope.api.rooms.finishLaunch({ version: VERSION, commandId, roomId, launchId: launch.launchId }),
    );
    if (outcome.kind === 'ok') await read();
    else if (outcome.kind === 'offline') settledFor = undefined;
  }

  async function load(): Promise<void> {
    await read();
    await settle();
  }

  /** Sends one command that records the person as playing, with the recording generation; the server may answer `not_saved`. */
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
    return acceptance.outcome === 'accepted' ? { kind: 'accepted' } : { kind: 'not_saved', reason: acceptance.reason };
  }

  /** What a command that did not succeed comes to for the screen: a refusal reads the Launch again, a `not_saved` says so and reads the policy. */
  async function settleFailure(result: Exclude<PlayResult, { kind: 'accepted' }>): Promise<false> {
    publish({ working: false });
    if (result.kind === 'offline') publish({ offline: true });
    else if (result.kind === 'refused') {
      publish({ refused: true });
      await read();
    } else if (result.kind === 'not_saved') {
      publish({ notSaved: result.reason });
      await scope.recording?.refresh();
    }
    return false;
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

    async start() {
      if (state.working) return false;
      publish({ working: true, refused: false, notSaved: undefined });
      const result = await play('start', (commandId, recordingGeneration) =>
        scope.api.rooms.startLaunch({ version: VERSION, commandId, roomId, recordingGeneration }),
      );
      if (result.kind !== 'accepted') return settleFailure(result);
      publish({ working: false });
      await load();
      return true;
    },

    async join() {
      const launch = state.view?.launch;
      if (launch === undefined || launch.phase === 'finished' || state.working) return false;
      publish({ working: true, refused: false, notSaved: undefined });
      const result = await play(`join:${launch.launchId}`, (commandId, recordingGeneration) =>
        scope.api.rooms.joinLaunch({
          version: VERSION,
          commandId,
          roomId,
          launchId: launch.launchId,
          recordingGeneration,
        }),
      );
      if (result.kind !== 'accepted') return settleFailure(result);
      publish({ working: false });
      await read();
      return true;
    },

    async answer(choice) {
      const launch = state.view?.launch;
      if (launch?.phase !== 'open' || launch.yourChoice !== undefined) return false;
      const view = state.view!;
      const { launchId, round } = launch;
      // The choice shows at once; a refusal or a lost connection puts the question back as the server last said it.
      publish({
        refused: false,
        notSaved: undefined,
        view: { ...view, launch: { ...launch, yourChoice: choice, youIn: true } },
      });
      const result = await play(`answer:${launchId}:${String(round)}`, (commandId, recordingGeneration) =>
        scope.api.rooms.answerLaunch({
          version: VERSION,
          commandId,
          roomId,
          launchId,
          round,
          choice,
          recordingGeneration,
        }),
      );
      if (result.kind === 'accepted') return true;
      publish({ view });
      return settleFailure(result);
    },
  };
}

/**
 * Posts the share card into a room's General as an ordinary message: the squares and nothing else, so it can't spoil the Launch for
 * anyone who has not played. The person does this on purpose (a button); nothing is sent by itself. True when the room took it.
 */
export async function shareLaunchResult(
  scope: AccountScope,
  input: { readonly roomId: string; readonly discussionId: string; readonly text: string; readonly commandId: string },
): Promise<boolean> {
  try {
    await scope.api.rooms.send({
      version: VERSION,
      commandId: input.commandId,
      roomId: input.roomId,
      discussionId: input.discussionId,
      body: { kind: 'text', text: input.text },
    });
    return true;
  } catch {
    return false;
  }
}
