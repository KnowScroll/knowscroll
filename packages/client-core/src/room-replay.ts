import {
  LAUNCH_ANSWER_SECONDS,
  LAUNCH_QUESTIONS,
  type LaunchHost,
  type ReplayRound,
  type RoomReplay,
  type RoomReplayStrip,
} from '@knowscroll/contracts';
import type { AccountScope } from './account-scope';
import { launchDayWords, squaresOf } from './room-launch';
import { talkFailure } from './talk-failure';

const VERSION = 'rooms.v1' as const;

/** The Launch to replay, as the server read it (the `replay` of a ready answer). */
export type ReplayData = NonNullable<Extract<RoomReplay, { status: 'ready' }>['replay']>;
type ReplayAnswer = Extract<ReplayRound, { status: 'ready' }>;

/** How long a question of the replay is open, in milliseconds, counted on this device's steady clock: nothing is judged by it. */
export const REPLAY_ANSWER_MS = LAUNCH_ANSWER_SECONDS * 1000;

// --- Words (pure) -----------------------------------------------------------------------------

/**
 * The line that says what a replay is, on every screen of it (R3 F: "Replays are labelled as replays"): the night it was played, how
 * many people played and that nothing is kept. Real numbers only.
 */
export function replayBanner(replay: Pick<ReplayData, 'day' | 'played'>): string {
  const who = replay.played === 1 ? 'the one person who played' : `the ${String(replay.played)} people who played`;
  return `Replay. These answers were given on ${launchDayWords(replay.day)} by ${who}. This one is just for you: nothing is saved, and the podium and the room’s star don’t change.`;
}

/** The Now strip's chip for a replay: the night it is of, never "last night" (the night is the server's UTC day). */
export const replayChip = (
  strip: RoomReplayStrip | undefined,
): { readonly label: string; readonly detail: string } | undefined =>
  strip === undefined ? undefined : { label: 'Replay', detail: `Launch of ${launchDayWords(strip.day)}` };

/** How many answered and got it right, with no name and no blame. */
export const replayCountLine = (answer: ReplayAnswer): string =>
  answer.locked === 0 ? 'Nobody answered this one.' : `${String(answer.right)} of ${String(answer.locked)} called it`;

/** The score at the end, in words, with the same squares as a Launch's share card: they hold no answer. */
export function replayScoreLine(squares: readonly boolean[]): string {
  const right = squares.filter(Boolean).length;
  return `You’d have got ${String(right)} of ${String(LAUNCH_QUESTIONS)} · ${squaresOf(squares)}`;
}

/** Where the person is in a replay. */
export type ReplayStep = 'idle' | 'asking' | 'revealed' | 'done';

/**
 * What the host says, in template words that depend only on where the replay is (D-219): labelled AI, no model behind any of it, and
 * never a word about a wrong answer beyond "plot twist".
 */
export function replayHostLine(
  host: Pick<LaunchHost, 'name'>,
  step: ReplayStep,
  index: number,
  outcome: { readonly picked: number | undefined; readonly correct: number } | undefined,
): string {
  switch (step) {
    case 'idle':
      return `${host.name} here. Five questions, ${String(LAUNCH_ANSWER_SECONDS)} seconds each, against the answers the people who played gave.`;
    case 'asking':
      return index === LAUNCH_QUESTIONS - 1 ? 'Last question. Go.' : `Question ${String(index + 1)}. Go.`;
    case 'revealed':
      if (outcome?.picked === undefined) return 'Time’s up on that one.';
      return outcome.picked === outcome.correct ? 'Called it!' : 'Plot twist.';
    case 'done':
      return 'That’s the replay.';
  }
}

// --- The controller ---------------------------------------------------------------------------

export interface RoomReplayState {
  /** `unavailable`: not a member, or no such room; the screen says so without saying why. */
  readonly phase: 'loading' | 'ready' | 'unavailable' | 'failed';
  readonly host: LaunchHost | undefined;
  /** The Launch to replay; absent when there is nothing real to replay now. */
  readonly replay: ReplayData | undefined;
  readonly step: ReplayStep;
  /** The question on screen, from zero. */
  readonly index: number;
  /** A steady-clock reading (milliseconds) taken when the question appeared. */
  readonly shownAt: number;
  /** The option the person chose for the question on screen. */
  readonly picked: number | undefined;
  /** The question on screen, answered: its key, its reason and who got it right. */
  readonly answer: ReplayAnswer | undefined;
  /** One entry per question answered so far: right or not. */
  readonly squares: readonly boolean[];
  readonly working: boolean;
  readonly offline: boolean;
}

export interface RoomReplayController {
  readonly getState: () => RoomReplayState;
  readonly subscribe: (listener: () => void) => () => void;
  /** Reads what can be replayed. Nothing is recorded about the person by reading it. */
  readonly load: () => Promise<void>;
  /** Starts the replay from its first question. */
  readonly begin: () => void;
  /** Answers the question on screen with the option at `choice`; the first tap stands. */
  readonly pick: (choice: number) => Promise<void>;
  /** The question's time ran out on this device's clock: its key is shown and no choice is made. */
  readonly timeUp: () => Promise<void>;
  /** The next question, or the end after the last. */
  readonly next: () => void;
  /** Leaves the replay: back to where it begins. */
  readonly leave: () => void;
}

export interface RoomReplayOptions {
  readonly scope: AccountScope;
  readonly roomId: string;
  readonly newId: () => string;
  /** A steady clock in milliseconds (never a date): `performance.now` in the app. */
  readonly clock: () => number;
}

const initial: RoomReplayState = {
  phase: 'loading',
  host: undefined,
  replay: undefined,
  step: 'idle',
  index: 0,
  shownAt: 0,
  picked: undefined,
  answer: undefined,
  squares: [],
  working: false,
  offline: false,
};

/**
 * One room's replay of a finished Launch (R3 F, D-241). The server owns the key and the recorded answers and keeps nothing about the
 * person playing: this holds the questions it gave, where the person is in them and what each answer came back as. The time a
 * question takes is this device's own steady clock and decides nothing but the line "you'd have been 2nd fastest". Leaving, reloading
 * or losing the connection loses nothing but the person's place.
 */
export function createRoomReplay(options: RoomReplayOptions): RoomReplayController {
  const { scope, roomId, newId, clock } = options;
  const listeners = new Set<() => void>();
  let state: RoomReplayState = initial;
  const publish = (patch: Partial<RoomReplayState>): void => {
    if (!scope.active) return;
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  };

  /**
   * Asks the server for one question's answer; `choice` is absent when the time ran out. The read carries neither the choice nor the
   * time: the answer is the same whatever was tapped, and a read that took a time could be swept to learn when others answered (D-241).
   */
  async function reveal(choice: number | undefined): Promise<void> {
    const { replay, index } = state;
    if (replay === undefined || state.step !== 'asking' || state.working) return;
    publish({ working: true, offline: false, picked: choice });
    try {
      const answer = await scope.api.rooms.replayRound({
        version: VERSION,
        readId: newId(),
        roomId,
        launchId: replay.launchId,
        round: index + 1,
      });
      if (answer.status !== 'ready') {
        publish({ working: false, phase: 'unavailable', replay: undefined, step: 'idle' });
        return;
      }
      publish({
        working: false,
        step: 'revealed',
        answer,
        squares: [...state.squares, choice === answer.correct],
      });
    } catch (error) {
      const failure = talkFailure(error);
      if (failure === 'ended') return;
      if (failure === 'unavailable') publish({ working: false, phase: 'unavailable', replay: undefined, step: 'idle' });
      else publish({ working: false, picked: undefined, offline: true });
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    async load() {
      try {
        const read = await scope.api.rooms.replay({ version: VERSION, readId: newId(), roomId });
        if (read.status === 'unavailable') {
          publish({ phase: 'unavailable', replay: undefined, host: undefined });
          return;
        }
        // A replay that has gone since (its seven days ended, its Launch was changed) ends the one in hand.
        const gone = read.replay === undefined || read.replay.launchId !== state.replay?.launchId;
        publish({
          phase: 'ready',
          host: read.host,
          replay: read.replay,
          offline: false,
          ...(gone ? { step: 'idle', index: 0, picked: undefined, answer: undefined, squares: [] } : {}),
        });
      } catch (error) {
        const failure = talkFailure(error);
        if (failure === 'ended') return;
        if (failure === 'unavailable') publish({ phase: 'unavailable', replay: undefined });
        else if (state.phase === 'loading') publish({ phase: 'failed', offline: failure === 'offline' });
        else publish({ offline: true });
      }
    },

    begin() {
      if (state.replay === undefined) return;
      publish({
        step: 'asking',
        index: 0,
        shownAt: clock(),
        picked: undefined,
        answer: undefined,
        squares: [],
        offline: false,
      });
    },

    pick: (choice) => (state.picked === undefined ? reveal(choice) : Promise.resolve()),
    timeUp: () => reveal(undefined),

    next() {
      if (state.step !== 'revealed') return;
      if (state.index + 1 >= LAUNCH_QUESTIONS) {
        publish({ step: 'done', picked: undefined, answer: undefined });
        return;
      }
      publish({ step: 'asking', index: state.index + 1, shownAt: clock(), picked: undefined, answer: undefined });
    },

    leave() {
      publish({
        step: 'idle',
        index: 0,
        picked: undefined,
        answer: undefined,
        squares: [],
        working: false,
        offline: false,
      });
    },
  };
}
