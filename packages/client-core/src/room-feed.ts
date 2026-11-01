import { type RoomFeed, type RoomFeedPost, type RoomFeedStrip, type RoomMemory } from '@knowscroll/contracts';
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

/** The Now strip's chip for the feed: who found something, and how long ago. Never a count. */
export function feedChip(strip: RoomFeedStrip | undefined, now: Date): { label: string; detail: string } | undefined {
  if (strip === undefined) return undefined;
  const age = now.getTime() - new Date(strip.postedAt).getTime();
  return { label: 'Feed', detail: `${strip.by.name} found something · ${agoWords(age)}` };
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

// --- The controller -------------------------------------------------------------------------

export interface RoomFeedState {
  /** `unavailable`: not a member, or no such room; the screen says so without saying why. */
  readonly phase: 'loading' | 'ready' | 'unavailable' | 'failed';
  readonly view: Ready | undefined;
  readonly offline: boolean;
  readonly working: boolean;
  /** The last change to the memory was refused; the screen says so and shows how it stands. */
  readonly refused: boolean;
}

export interface RoomFeedController {
  readonly getState: () => RoomFeedState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly load: () => Promise<void>;
  /** A moderator replaces what the residents remember with their words, or clears it (`null`). Returns whether the server accepted. */
  readonly replaceMemory: (text: string | null) => Promise<boolean>;
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
 * One room's feed for a member: the finds residents posted, what they remember and the rules they post by. Opening the feed
 * is not an event and creates no evidence. The server shapes the answer for the reader's AI level; this keeps the last answer
 * and the one command in flight.
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

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    load,
    async replaceMemory(text) {
      if (state.working) return false;
      publish({ working: true, refused: false });
      const outcome = await run(`memory:${text ?? 'clear'}`, (commandId) =>
        scope.api.rooms.replaceMemory({ version: VERSION, commandId, roomId, text }),
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
      await load();
      return true;
    },
  };
}
