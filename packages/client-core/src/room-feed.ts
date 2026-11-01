import {
  type RoomFeed,
  type RoomFeedPost,
  type RoomFeedStrip,
  type RoomMemory,
  type RoomScout,
  type RoomScoutCadence,
} from '@knowscroll/contracts';
import type { AccountScope } from './account-scope';
import { intentRunner } from './room-activity';
import { agoWords } from './room-presence';
import { talkFailure } from './talk-failure';

const VERSION = 'rooms.v1' as const;

type Ready = Extract<RoomFeed, { status: 'ready' }>;

// --- Words (pure) ---------------------------------------------------------------------------

/** What the asset of a find is, in a word: never a score. */
export const findKindWord = (post: Pick<RoomFeedPost, 'content'>): string => {
  const { content } = post;
  const metadata =
    content.status === 'available'
      ? content.metadata
      : content.status === 'corrected'
        ? content.current.metadata
        : undefined;
  return metadata === undefined ? 'Gone from the library' : metadata.kind === 'reel' ? 'Reel' : 'Scroll';
};

/** The title of the asset a find is about, or the plain words for one that was withdrawn since. */
export const findTitleWords = (post: Pick<RoomFeedPost, 'content'>): string => {
  const { content } = post;
  const metadata =
    content.status === 'available'
      ? content.metadata
      : content.status === 'corrected'
        ? content.current.metadata
        : undefined;
  return metadata?.title ?? 'This is no longer in the library';
};

type FeedAuthor = RoomFeedPost['author'];

/** Who a find is by, in a name: a resident's own, or "Asha’s scout" for the scout a member sent (D-259). */
export const feedAuthorName = (author: FeedAuthor): string =>
  author.kind === 'ai' ? author.name : `${author.sentBy.displayName}’s scout`;

/** The line that signs a scout's find, so nobody reads it as the member's own words; none for a resident. */
export const scoutSignature = (author: FeedAuthor): string | undefined =>
  author.kind === 'agent' ? `Sent by ${author.sentBy.displayName}` : undefined;

/** The Now strip's chip for the feed: who found something, and how long ago. Never a count. */
export function feedChip(strip: RoomFeedStrip | undefined, now: Date): { label: string; detail: string } | undefined {
  if (strip === undefined) return undefined;
  const age = now.getTime() - new Date(strip.postedAt).getTime();
  return { label: 'Feed', detail: `${feedAuthorName(strip.by)} found something · ${agoWords(age)}` };
}

/**
 * How residents post, in the words the profile shows: from the server's own numbers, so a screen cannot say one thing while the
 * rules do another. A rhythm, not a promise: a look with nothing new posts nothing.
 */
export function rhythmLines(limits: Ready['limits']): { readonly checksIn: string; readonly posts: string } {
  return {
    checksIn: `Looks at the room about ${String(limits.postsPerDay)} times a day`,
    posts: `Each posts at most once every ${String(limits.restHours)} hours`,
  };
}

/** The honest words for an empty feed, by the reader's AI level: nothing is made up to fill it. */
export function emptyFeedWords(aiLevel: Ready['aiLevel']): { readonly title: string; readonly body: string } {
  return aiLevel === 'off'
    ? {
        title: 'Residents are off for you',
        body: 'You chose not to see what residents post on their own. You can turn them on in AI here.',
      }
    : {
        title: 'Nothing new right now',
        body: 'Residents post when the library has something new for this room. They say nothing when it has not.',
      };
}

/** What the residents remember, as a line for a screen: the words, or the honest none. */
export const memoryWords = (memory: RoomMemory): string | undefined =>
  memory.state === 'ready' ? memory.text : undefined;

// --- A member's own scout (v3 R-9) ----------------------------------------------------------

/** How often a scout may post, as the sheet says it. It is a cap, never a promise. */
export const scoutCadenceWords: Readonly<Record<RoomScoutCadence, string>> = {
  daily: 'Once a day',
  weekly: 'Once a week',
};

/** What a member chooses for their scout: the room's topics to look in, how often, and whether it is paused. */
export interface ScoutDraft {
  readonly interests: readonly string[];
  readonly cadence: RoomScoutCadence;
  readonly paused: boolean;
}

/** The draft a sheet opens with: the scout as it stands, or an empty choice for the member to make. */
export function scoutDraftOf(scout: RoomScout): ScoutDraft {
  return scout.state === 'on'
    ? { interests: scout.interests, cadence: scout.cadence, paused: scout.paused }
    : { interests: [], cadence: 'daily', paused: false };
}

/** Adds or removes one topic, never past the most a scout may look in. */
export function toggleInterest(draft: ScoutDraft, topicId: string, most: number): ScoutDraft {
  if (draft.interests.includes(topicId))
    return { ...draft, interests: draft.interests.filter((interest) => interest !== topicId) };
  return draft.interests.length >= most ? draft : { ...draft, interests: [...draft.interests, topicId] };
}

/** What the sheet says a scout is doing now. It never says what the scout read, for it reads nothing of the member's. */
export function scoutStatusWords(scout: RoomScout, now: Date): string {
  if (scout.state === 'none') return 'No scout sent to this room yet.';
  if (scout.stopped) return 'A moderator stopped your scout in this room. It posts nothing until a moderator lets it.';
  const last =
    scout.lastPostedAt === undefined
      ? 'It has not posted here yet.'
      : `It last posted here ${agoWords(now.getTime() - new Date(scout.lastPostedAt).getTime())}.`;
  return scout.paused ? `Paused. It posts nothing until you start it again. ${last}` : `Looking. ${last}`;
}

// --- The controller -------------------------------------------------------------------------

export interface RoomFeedState {
  /** `unavailable`: not a member, or no such room; the screen says so without saying why. */
  readonly phase: 'loading' | 'ready' | 'unavailable' | 'failed';
  readonly view: Ready | undefined;
  readonly offline: boolean;
  readonly working: boolean;
  /** The last change (to the memory or to a scout) was refused; the screen says so and shows how it stands. */
  readonly refused: boolean;
}

export interface RoomFeedController {
  readonly getState: () => RoomFeedState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly load: () => Promise<void>;
  /** A moderator replaces what the residents remember with their words, or clears it (`null`). Returns whether the server accepted. */
  readonly replaceMemory: (text: string | null) => Promise<boolean>;
  /** Sends the member's own scout, changes it, pauses it, or takes it back (`null`). Returns whether the server accepted. */
  readonly setScout: (scout: ScoutDraft | null) => Promise<boolean>;
  /** A moderator stops a member's scout in this room, or lets it post again. Returns whether the server accepted. */
  readonly stopScout: (personId: string, stopped: boolean) => Promise<boolean>;
}

export interface RoomFeedOptions {
  readonly scope: AccountScope;
  readonly roomId: string;
  readonly newId: () => string;
}

const initialFeed: RoomFeedState = {
  phase: 'loading',
  view: undefined,
  offline: false,
  working: false,
  refused: false,
};

/**
 * One room's feed for a member: the finds residents and scouts posted, what the residents remember, the rules they post by and
 * the member's own scout. Opening the feed is not an event and creates no evidence. The server shapes the answer for the reader's
 * AI level; this keeps the last answer and the one command in flight.
 */
export function createRoomFeed(options: RoomFeedOptions): RoomFeedController {
  const { scope, roomId, newId } = options;
  const listeners = new Set<() => void>();
  const run = intentRunner(newId);
  let state = initialFeed;
  const publish = (patch: Partial<RoomFeedState>): void => {
    if (!scope.active) return;
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  };

  async function load(): Promise<void> {
    try {
      const answer = await scope.api.rooms.feed({ version: VERSION, readId: newId(), roomId });
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

  /** One command, answered the same way for every outcome: working while it runs, a refusal shown with the room as it stands. */
  async function change(intent: string, send: (commandId: string) => Promise<unknown>): Promise<boolean> {
    if (state.working) return false;
    publish({ working: true, refused: false });
    const outcome = await run(intent, send);
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
    await load();
    return true;
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    load,
    replaceMemory: (text) =>
      change(`memory:${text ?? 'clear'}`, (commandId) =>
        scope.api.rooms.replaceMemory({ version: VERSION, commandId, roomId, text }),
      ),
    setScout: (scout) =>
      change(`scout:${scout === null ? 'remove' : JSON.stringify(scout)}`, (commandId) =>
        scope.api.rooms.setScout({
          version: VERSION,
          commandId,
          roomId,
          scout:
            scout === null ? null : { interests: [...scout.interests], cadence: scout.cadence, paused: scout.paused },
        }),
      ),
    stopScout: (personId, stopped) =>
      change(`scout-stop:${personId}:${String(stopped)}`, (commandId) =>
        scope.api.rooms.moderate({
          version: VERSION,
          commandId,
          roomId,
          action: { kind: stopped ? 'stop_scout' : 'allow_scout', personId },
        }),
      ),
  };
}
