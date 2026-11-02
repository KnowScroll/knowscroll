import {
  ROOM_STARS_PER_CONSTELLATION,
  type RoomFlairChoice,
  type RoomFlairKind,
  type RoomFlairView,
  type RoomSky,
  type RoomSkyView,
  type RoomStar,
  type RoomStation,
  type RoomToday,
} from '@knowscroll/contracts';
import type { AccountScope } from './account-scope';
import { intentRunner } from './room-activity';
import { talkFailure } from './talk-failure';

const VERSION = 'rooms.v1' as const;

type TodayReady = Extract<RoomToday, { status: 'ready' }>;
type SkyReady = Extract<RoomSkyView, { status: 'ready' }>;
type FlairReady = Extract<RoomFlairView, { status: 'ready' }>;

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

/**
 * A station's line under its name: the count, and the name the room earned (kept while the next constellation forms, so a
 * room that has named one never loses it). A constellation waiting for its name is "Lit".
 */
export function stationSkyLine(sky: Pick<RoomSky, 'lit' | 'state' | 'constellationName'>): string {
  const base = skyLine(sky);
  if (sky.state === 'naming') return `${base} · Lit`;
  return sky.constellationName === undefined ? base : `${base} · ${sky.constellationName}`;
}

/** What is on in a room, in the words a station uses (D-268). */
const liveWords = (live: RoomStation['live']): string | undefined =>
  live === undefined ? undefined : live === 'launch' ? 'Launch live' : 'Reel live';

/**
 * A station's caption on the map: its sky line, and what is live while the room is playing a Launch or watching a Reel (R3 E, D-178,
 * D-268). The room's activity is shown to its members only, on their own map; a station that carries no `live` says nothing of it.
 */
export function stationCaption(
  sky: Pick<RoomSky, 'lit' | 'state' | 'constellationName'>,
  live: RoomStation['live'],
): string {
  const words = liveWords(live);
  return words === undefined ? stationSkyLine(sky) : `${stationSkyLine(sky)} · ${words}`;
}

/**
 * A station's label on the map: the count and, while one is on, what is live (D-268). The constellation's name stays in the
 * spoken name and the lists, so a label stays short enough to find room.
 */
export function stationMapCaption(sky: Pick<RoomSky, 'lit'>, live: RoomStation['live']): string {
  const words = liveWords(live);
  return words === undefined ? skyLine(sky) : `${skyLine(sky)} · ${words}`;
}

/** A UTC day as the sky's list says it: "25 Oct" (a star's day is a UTC day, so it is read in UTC). */
const shortDay = (day: string): string =>
  new Date(`${day}T12:00:00.000Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/**
 * What earned a star, in the words R3 E5 uses under the sky ("Asha’s answer marked useful · 25 Oct"). A person is named only
 * where the server named one for this reader; a debate by its title; a Launch by how many played and nobody by name. Without a
 * moment the act's own words stand in, so an answer that was removed or whose author the reader blocked still reads as one found
 * useful.
 */
export function starMomentWords(star: RoomStar): string {
  const day = shortDay(star.day);
  switch (star.act) {
    case 'answer_useful':
      return `${star.by === undefined ? 'An answer' : `${star.by.displayName}’s answer`} marked useful · ${day}`;
    case 'debate_closed':
      return `${star.title === undefined ? 'Debate closed' : `Debate closed: ${star.title}`} · ${day}`;
    case 'daily_solved':
      return `Spot the flaw found · ${day}`;
    case 'launch_finished':
      return star.played === undefined ? `Launch, ${day}` : `Launch, ${day} · ${String(star.played)} played`;
  }
}

/** The marks a person can earn, as a chip says them (R3 E5). Fixed words, never a model's. */
export const FLAIR_WORDS: Record<RoomFlairKind, string> = {
  first_answer: 'First answer',
  good_question: 'Good question',
  flaw_finder: 'Flaw finder',
  launch_regular: 'Launch regular',
};

/** What earns each mark, in one line, for the person's own card. The numbers are the server's (`of`), never stated here. */
export const FLAIR_HOW: Record<RoomFlairKind, string> = {
  first_answer: 'You answered a question, or Today’s.',
  good_question: 'Questions you left that someone found useful.',
  flaw_finder: 'Flaws you found in Spot the flaw.',
  launch_regular: 'Launches you played this week.',
};

/** A mark that is partway: "Flaw finder · 2/3". */
export const flairProgressWords = (coming: FlairReady['coming'][number]): string =>
  `${FLAIR_WORDS[coming.flair]} · ${String(coming.have)}/${String(coming.of)}`;

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

/**
 * The stars of the constellation being made, newest first, for the list under the art ("How each star was earned"). Each is
 * the moment as the server read it for this reader, so the sheet never builds a name or a title of its own.
 */
export const momentsOfCurrent = (view: Pick<SkyReady, 'sky' | 'stars'>): readonly RoomStar[] =>
  [...starsOfCurrent(view)].reverse();

// --- Today ----------------------------------------------------------------------------------

export interface RoomTodayState {
  /** `unavailable`: not a member, or no such room; the screen says so without saying why. */
  readonly phase: 'loading' | 'ready' | 'unavailable' | 'failed';
  readonly view: TodayReady | undefined;
  readonly offline: boolean;
  readonly working: boolean;
  /** The last tap was refused (the item changed meanwhile); the screen says so and shows how it stands. */
  readonly refused: boolean;
  /**
   * The last tap was not kept: recording is paused (the person's choice) or this device's settings were out of date. Nothing
   * was stored and the key stays on the server; the screen says so and the tap can be made again (D-176).
   */
  readonly notSaved: 'recording_paused' | 'recording_generation_stale' | undefined;
  /** The item whose last tap earned the room a star, so the card can say "+1 star for the room" once. */
  readonly starFor: string | undefined;
}

export interface RoomTodayController {
  readonly getState: () => RoomTodayState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly load: () => Promise<void>;
  /**
   * Taps one sentence of today's Spot the flaw. The tap is final: a retry after an unknown outcome is the same command
   * and a second tap on a finished item changes nothing. While recording is paused nothing is sent (the server would keep the
   * tap, so it refuses). Returns whether the server accepted and kept it.
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
  notSaved: undefined,
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
      if (scope.recording?.getState().policy?.on === false) {
        publish({ refused: false, notSaved: 'recording_paused' });
        return false;
      }
      publish({ working: true, refused: false, notSaved: undefined });
      const outcome = await run(`solve:${ritualId}`, async (commandId) => {
        const recordingGeneration = await scope.recording?.generation();
        if (recordingGeneration === undefined) throw new Error('recording_policy_unavailable');
        return scope.api.rooms.solveFlaw({
          version: VERSION,
          commandId,
          roomId,
          ritualId,
          sentence,
          recordingGeneration,
        });
      });
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
      if (outcome.value.outcome === 'not_saved') {
        publish({ notSaved: outcome.value.reason });
        await scope.recording?.refresh();
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
  /**
   * The person's own flair card for the room (R3 E5), read with the sky. Absent while it loads or when it could not be read: the
   * sky does not wait for it, and a sheet without it simply has no card.
   */
  readonly flair: FlairReady | undefined;
  readonly offline: boolean;
  readonly working: boolean;
  readonly refused: boolean;
}

export interface RoomSkyController {
  readonly getState: () => RoomSkyState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly load: () => Promise<void>;
  /**
   * Chooses one of the three names offered for `constellation` (the number the sheet shows); the member may change it until
   * it closes. The server refuses a vote for any other constellation than the one open, so a sheet that is out of date counts
   * for nothing and the sky is read again.
   */
  readonly name: (constellation: number, candidate: number) => Promise<boolean>;
  /**
   * Chooses what shows beside the person's name: a mark they have earned, `none` to hide it, or `auto`. The same choice again is
   * accepted; a mark that is no longer earned is refused and the card is read again to say so.
   */
  readonly chooseFlair: (choice: RoomFlairChoice | 'auto') => Promise<boolean>;
}

const initialSky: RoomSkyState = {
  phase: 'loading',
  view: undefined,
  flair: undefined,
  offline: false,
  working: false,
  refused: false,
};

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

  /** The flair card is read beside the sky and never holds it up: a card that cannot be read is no card, and the sky is still there. */
  async function loadFlair(): Promise<void> {
    try {
      const card = await scope.api.rooms.flair({ version: VERSION, readId: newId(), roomId });
      publish({ flair: card.status === 'ready' ? card : undefined });
    } catch {
      // Not a failure of the sky; the card stays as it was.
    }
  }

  async function loadSky(): Promise<void> {
    try {
      const answer = await scope.api.rooms.sky({ version: VERSION, readId: newId(), roomId });
      if (answer.status === 'unavailable')
        publish({ phase: 'unavailable', view: undefined, flair: undefined, offline: false });
      else publish({ phase: 'ready', view: answer, offline: false });
    } catch (error) {
      const failure = talkFailure(error);
      if (failure === 'ended') return;
      if (failure === 'unavailable') publish({ phase: 'unavailable', view: undefined, flair: undefined });
      else if (state.phase === 'loading') publish({ phase: 'failed', offline: failure === 'offline' });
      else publish({ offline: true });
    }
  }

  const load = async (): Promise<void> => {
    await Promise.all([loadSky(), loadFlair()]);
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    load,
    async name(constellation, candidate) {
      if (state.working) return false;
      publish({ working: true, refused: false });
      const outcome = await run(`name:${String(constellation)}:${String(candidate)}`, (commandId) =>
        scope.api.rooms.nameConstellation({ version: VERSION, commandId, roomId, constellation, candidate }),
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
    async chooseFlair(choice) {
      if (state.working) return false;
      publish({ working: true });
      const outcome = await run(`flair:${choice}`, (commandId) =>
        scope.api.rooms.chooseFlair({ version: VERSION, commandId, roomId, flair: choice }),
      );
      publish({ working: false });
      if (outcome.kind === 'ended') return false;
      if (outcome.kind === 'offline') {
        publish({ offline: true });
        return false;
      }
      await loadFlair();
      return outcome.kind === 'ok';
    },
  };
}
