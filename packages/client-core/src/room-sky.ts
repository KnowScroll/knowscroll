import {
  ROOM_STARS_PER_CONSTELLATION,
  type RoomSky,
  type RoomSkyView,
  type RoomStar,
  type RoomStarAct,
  type RoomToday,
} from '@knowscroll/contracts';
import type { AccountScope } from './account-scope';
import { intentRunner } from './room-activity';
import { talkFailure } from './talk-failure';

const VERSION = 'rooms.v1' as const;

type TodayReady = Extract<RoomToday, { status: 'ready' }>;
type SkyReady = Extract<RoomSkyView, { status: 'ready' }>;

// --- Words and shape (pure) -----------------------------------------------------------------

/**
 * The seven points of a constellation, in the order the stars are earned, in a unit box (x right, y down). An arch, so on a
 * station it rises over the emblem. One fixed shape for every room, so a star keeps its place as the sky fills; the sheet and the station draw the same points.
 */
export const CONSTELLATION_POINTS: readonly (readonly [number, number])[] = [
  [0.06, 0.78],
  [0.14, 0.5],
  [0.3, 0.34],
  [0.5, 0.14],
  [0.7, 0.3],
  [0.86, 0.44],
  [0.94, 0.74],
];

/** The stars of the constellation being made, in words: "3 of 7". A room never says how many people did anything. */
export const skyLine = (sky: Pick<RoomSky, 'lit'>): string =>
  `${String(sky.lit)} of ${String(ROOM_STARS_PER_CONSTELLATION)}`;

/** A station's line under its name: the count, and the name once a constellation has one. */
export function stationSkyLine(sky: Pick<RoomSky, 'lit' | 'state' | 'constellationName'>): string {
  const base = skyLine(sky);
  if (sky.state === 'named' && sky.constellationName !== undefined) return `${base} · ${sky.constellationName}`;
  return sky.state === 'naming' ? `${base} · Lit` : base;
}

/** What a star is, in the act's own words: fixed text, never a message, a title or a person. */
export const STAR_ACT_WORDS: Record<RoomStarAct, string> = {
  answer_useful: 'An answer someone found useful',
  debate_closed: 'A debate closed by vote',
  daily_solved: 'The day’s Spot the flaw found',
};

/**
 * The constellation being made now: the finished one while it is at seven (it stays full until the next star), the next
 * one otherwise.
 */
export const currentConstellation = (sky: RoomSky): number =>
  sky.lit === ROOM_STARS_PER_CONSTELLATION ? sky.finished : sky.finished + 1;

/** The stars of the constellation being made, oldest first: star `i` is drawn at `CONSTELLATION_POINTS[i]`. */
export function starsOfCurrent(view: Pick<SkyReady, 'sky' | 'stars'>): readonly RoomStar[] {
  const number = currentConstellation(view.sky);
  return view.stars
    .filter((star) => star.constellation === number)
    .reverse()
    .slice(0, ROOM_STARS_PER_CONSTELLATION);
}

// --- Today ----------------------------------------------------------------------------------

export interface RoomTodayState {
  /** `unavailable`: not a member, or no such room; the screen says so without saying why. */
  readonly phase: 'loading' | 'ready' | 'unavailable' | 'failed';
  readonly view: TodayReady | undefined;
  readonly offline: boolean;
  readonly working: boolean;
  /** The last tap was refused (the item changed meanwhile); the screen says so and shows how it stands. */
  readonly refused: boolean;
  /** The item whose last tap earned the room a star, so the card can say "+1 star for the room" once. */
  readonly starFor: string | undefined;
}

export interface RoomTodayController {
  readonly getState: () => RoomTodayState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly load: () => Promise<void>;
  /**
   * Taps one sentence of today's Spot the flaw. The tap is final: a retry after an unknown outcome is the same command
   * and a second tap on a finished item changes nothing. Returns whether the server accepted it.
   */
  readonly solve: (ritualId: string, sentence: number) => Promise<boolean>;
}

export interface RoomTodayOptions {
  readonly scope: AccountScope;
  readonly roomId: string;
  readonly newId: () => string;
}

const initialToday: RoomTodayState = {
  phase: 'loading',
  view: undefined,
  offline: false,
  working: false,
  refused: false,
  starFor: undefined,
};

/**
 * One room's Today: the day's question and Spot the flaw as an operator approved them, and the member's own tap. The
 * server owns the key, so a view carries it only after the member has tapped. Nothing here is evidence or a score.
 */
export function createRoomToday(options: RoomTodayOptions): RoomTodayController {
  const { scope, roomId, newId } = options;
  const listeners = new Set<() => void>();
  const run = intentRunner(newId);
  let state = initialToday;
  const publish = (patch: Partial<RoomTodayState>): void => {
    if (!scope.active) return;
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  };

  async function load(): Promise<void> {
    try {
      const answer = await scope.api.rooms.today({ version: VERSION, readId: newId(), roomId });
      if (answer.status === 'unavailable') publish({ phase: 'unavailable', view: undefined, offline: false });
      else publish({ phase: 'ready', view: answer, offline: false });
    } catch (error) {
      const failure = talkFailure(error);
      if (failure === 'ended') return;
      if (failure === 'unavailable') publish({ phase: 'unavailable', view: undefined });
      else if (state.phase === 'loading') publish({ phase: 'failed', offline: failure === 'offline' });
      else publish({ offline: true });
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    load,
    async solve(ritualId, sentence) {
      if (state.working) return false;
      publish({ working: true, refused: false });
      const outcome = await run(`solve:${ritualId}`, (commandId) =>
        scope.api.rooms.solveFlaw({ version: VERSION, commandId, roomId, ritualId, sentence }),
      );
      publish({ working: false });
      if (outcome.kind === 'ended') return false;
      if (outcome.kind === 'offline') {
        publish({ offline: true });
        return false;
      }
      if (outcome.kind === 'refused') {
        publish({ refused: true });
        await load();
        return false;
      }
      publish({ starFor: outcome.value.star ? ritualId : undefined });
      await load();
      return true;
    },
  };
}

// --- The sky --------------------------------------------------------------------------------

export interface RoomSkyState {
  readonly phase: 'loading' | 'ready' | 'unavailable' | 'failed';
  readonly view: SkyReady | undefined;
  readonly offline: boolean;
  readonly working: boolean;
  readonly refused: boolean;
}

export interface RoomSkyController {
  readonly getState: () => RoomSkyState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly load: () => Promise<void>;
  /** Chooses one of the three names offered for the constellation being named; the member may change it until it closes. */
  readonly name: (candidate: number) => Promise<boolean>;
}

const initialSky: RoomSkyState = { phase: 'loading', view: undefined, offline: false, working: false, refused: false };

/** One room's sky for a member: its stars, its constellation, and the name vote while one is open. */
export function createRoomSky(options: RoomTodayOptions): RoomSkyController {
  const { scope, roomId, newId } = options;
  const listeners = new Set<() => void>();
  const run = intentRunner(newId);
  let state = initialSky;
  const publish = (patch: Partial<RoomSkyState>): void => {
    if (!scope.active) return;
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  };

  async function load(): Promise<void> {
    try {
      const answer = await scope.api.rooms.sky({ version: VERSION, readId: newId(), roomId });
      if (answer.status === 'unavailable') publish({ phase: 'unavailable', view: undefined, offline: false });
      else publish({ phase: 'ready', view: answer, offline: false });
    } catch (error) {
      const failure = talkFailure(error);
      if (failure === 'ended') return;
      if (failure === 'unavailable') publish({ phase: 'unavailable', view: undefined });
      else if (state.phase === 'loading') publish({ phase: 'failed', offline: failure === 'offline' });
      else publish({ offline: true });
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    load,
    async name(candidate) {
      if (state.working) return false;
      publish({ working: true, refused: false });
      const outcome = await run(`name:${String(candidate)}`, (commandId) =>
        scope.api.rooms.nameConstellation({ version: VERSION, commandId, roomId, candidate }),
      );
      publish({ working: false });
      if (outcome.kind === 'ended') return false;
      if (outcome.kind === 'offline') {
        publish({ offline: true });
        return false;
      }
      if (outcome.kind === 'refused') publish({ refused: true });
      await load();
      return outcome.kind === 'ok';
    },
  };
}
