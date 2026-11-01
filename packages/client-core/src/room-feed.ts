import {
  ROOM_POST_TITLE_MAX_CHARS,
  ROOM_POST_WORDS_MAX_CHARS,
  type ConversationContentProjection,
  type PostRoomFind,
  type RoomFeed,
  type RoomFeedPost,
  type RoomFeedSort,
  type RoomFeedStrip,
  type RoomFeedWindow,
  type RoomMemory,
  type RoomScout,
  type RoomScoutCadence,
} from '@knowscroll/contracts';
import type { AccountScope } from './account-scope';
import { apiProblem } from './api-client';
import { intentRunner } from './room-activity';
import { agoWords } from './room-presence';
import { talkFailure } from './talk-failure';

const VERSION = 'rooms.v1' as const;

type Ready = Extract<RoomFeed, { status: 'ready' }>;

// --- Words (pure) ---------------------------------------------------------------------------

const metadataOf = (content: ConversationContentProjection | undefined) =>
  content === undefined
    ? undefined
    : content.status === 'available'
      ? content.metadata
      : content.status === 'corrected'
        ? content.current.metadata
        : undefined;

/** The Reel or Scroll a post is about, as a card; none for a member's post that cites a source. */
export const postCard = (post: RoomFeedPost): ConversationContentProjection | undefined =>
  post.kind === 'find' ? post.content : post.link.kind === 'content' ? post.link.content : undefined;

/** What the asset of a find is, in a word: never a score. */
export const findKindWord = (post: { readonly content: ConversationContentProjection }): string => {
  const metadata = metadataOf(post.content);
  return metadata === undefined ? 'Gone from the library' : metadata.kind === 'reel' ? 'Reel' : 'Scroll';
};

/** The title of the asset of a find, or the plain words for one that was withdrawn since. */
export const findTitleWords = (post: { readonly content: ConversationContentProjection }): string =>
  metadataOf(post.content)?.title ?? 'This is no longer in the library';

/** What a post links, in a word: Reel, Scroll, Link (a source), or the plain words for an asset that was withdrawn. */
export function postKindWord(post: RoomFeedPost): string {
  const card = postCard(post);
  return card === undefined ? 'Link' : findKindWord({ content: card });
}

/** What a post is called when it is read aloud or opened: a member's own headline, or the title of the asset a find is about. */
export const postTitleWords = (post: RoomFeedPost): string =>
  post.kind === 'post' ? post.title : findTitleWords({ content: post.content });

type FeedAuthor = RoomFeedPost['author'];

/** Who a post is by, in a name: a resident's own, "Asha’s scout" for the scout a member sent (D-259), or the member's. */
export const feedAuthorName = (author: FeedAuthor): string =>
  author.kind === 'ai'
    ? author.name
    : author.kind === 'agent'
      ? `${author.sentBy.displayName}’s scout`
      : author.you
        ? 'You'
        : author.person.displayName;

/** The line that signs a scout's find, so nobody reads it as the member's own words; none for a resident. */
export const scoutSignature = (author: FeedAuthor): string | undefined =>
  author.kind === 'agent' ? `Sent by ${author.sentBy.displayName}` : undefined;

/** The Now strip's chip for the feed: who found something, and how long ago. Never a count. */
export function feedChip(strip: RoomFeedStrip | undefined, now: Date): { label: string; detail: string } | undefined {
  if (strip === undefined) return undefined;
  const age = now.getTime() - new Date(strip.postedAt).getTime();
  return { label: 'Feed', detail: `${feedAuthorName(strip.by)} found something · ${agoWords(age)}` };
}

// --- Sorts, votes and a member's own post (v3 R-8b) ----------------------------------------------

/** The three ways the Feed is ordered, in the order the tabs show them. Rising is not offered (D-272). */
export const feedSorts: readonly { readonly sort: RoomFeedSort; readonly label: string }[] = [
  { sort: 'hot', label: 'Hot' },
  { sort: 'new', label: 'New' },
  { sort: 'top', label: 'Top' },
];

/** The windows Top counts, in the order they are offered. */
export const feedWindows: readonly { readonly window: RoomFeedWindow; readonly label: string }[] = [
  { window: 'day', label: 'Today' },
  { window: 'week', label: 'This week' },
  { window: 'month', label: 'This month' },
  { window: 'all', label: 'All time' },
];

/** The words that say what a sort shows, for the line under the tabs. Never a score. */
export const sortWords: Readonly<Record<RoomFeedSort, string>> = {
  hot: 'Votes count for most, and fade as a post gets older',
  new: 'Newest first',
  top: 'Most votes first',
};

/** The vote's label for a screen reader: what it is, how many people, and whether the reader's is among them. */
export function voteWords(post: Pick<RoomFeedPost, 'votes' | 'youVoted' | 'canVote'>): string {
  const count = `${String(post.votes)} ${post.votes === 1 ? 'vote' : 'votes'}`;
  if (!post.canVote) return `${count}. Your own post`;
  return post.youVoted ? `${count}. You voted. Take your vote back` : `${count}. Vote up`;
}

/** What a member writes to post a find: their headline and words, and what it links. */
export interface PostDraft {
  readonly title: string;
  readonly words: string;
  readonly link: PostRoomFind['link'] | undefined;
}

/** A draft that has nothing yet, with no link chosen. */
export const emptyPostDraft: PostDraft = { title: '', words: '', link: undefined };

const ADDRESS_IN_TEXT = /https?:\/\/|www\./iu;
const PLAIN_ADDRESS = /^https?:\/\/\S+$/iu;

/** Whether the draft may be sent: the server's own shape rules, so the button never invites a refusal it could have said first. */
export function postDraftReady(draft: PostDraft): boolean {
  const title = draft.title.trim();
  const words = draft.words.trim();
  if (title === '' || [...title].length > ROOM_POST_TITLE_MAX_CHARS || ADDRESS_IN_TEXT.test(title)) return false;
  if (words === '' || [...words].length > ROOM_POST_WORDS_MAX_CHARS || ADDRESS_IN_TEXT.test(words)) return false;
  if (draft.link === undefined) return false;
  return draft.link.kind === 'content' || PLAIN_ADDRESS.test(draft.link.url.trim());
}

/** How a post to the Feed ended, in the few ways a sheet treats differently. */
export type PostOutcome =
  | { readonly kind: 'posted'; readonly discussionId: string }
  /** The room already had a post about it: nothing was made and this is where it is. */
  | { readonly kind: 'already_there'; readonly discussionId: string }
  | { readonly kind: 'rate_limited' }
  | { readonly kind: 'refused' }
  | { readonly kind: 'offline' };

/** The sheet's words for an outcome that did not post. */
export const postRefusalWords: Readonly<Record<'rate_limited' | 'refused' | 'offline', string>> = {
  rate_limited: 'You have posted as much as one room takes in a day. You can post here again tomorrow.',
  refused:
    'That could not be posted. Check the link: a source is the plain address of a page, with no sign-in, port or shortened link. The room may also have changed.',
  offline: 'Offline. Nothing was posted. Try again when you are back online.',
};

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
  if (scout.recordingPaused === true)
    return 'Recording is paused, so your scout posts nothing. It looks again when you turn recording back on.';
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
  /** The order the member asked for, and the window Top counts. */
  readonly sort: RoomFeedSort;
  readonly window: RoomFeedWindow;
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
  /** Changes the order of the Feed and reads it again. Hot is where it opens. */
  readonly setSort: (sort: RoomFeedSort) => Promise<void>;
  /** Changes the window Top counts and reads it again. */
  readonly setWindow: (window: RoomFeedWindow) => Promise<void>;
  /**
   * Votes up on a post, or takes the vote back. The post's votes and the reader's own mark are updated from the answer and the
   * order is left as it was until the next read, so a post does not jump under a thumb. Returns whether the server accepted.
   */
  readonly vote: (discussionId: string, voted: boolean) => Promise<boolean>;
  /** Posts a find. The Feed is read again when it posted. */
  readonly post: (draft: PostDraft) => Promise<PostOutcome>;
}

export interface RoomFeedOptions {
  readonly scope: AccountScope;
  readonly roomId: string;
  readonly newId: () => string;
}

const initialFeed: RoomFeedState = {
  phase: 'loading',
  view: undefined,
  sort: 'hot',
  window: 'week',
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
      const answer = await scope.api.rooms.feed({
        version: VERSION,
        readId: newId(),
        roomId,
        sort: state.sort,
        window: state.window,
      });
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
    async setSort(sort) {
      if (sort === state.sort) return;
      publish({ sort });
      await load();
    },
    async setWindow(window) {
      if (window === state.window) return;
      publish({ window });
      await load();
    },
    async vote(discussionId, voted) {
      if (state.working) return false;
      publish({ working: true, refused: false });
      const outcome = await run(`vote:${discussionId}:${String(voted)}`, (commandId) =>
        scope.api.rooms.votePost({ version: VERSION, commandId, roomId, discussionId, voted }),
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
      const { votes } = outcome.value;
      const view = state.view;
      if (view !== undefined)
        publish({
          view: {
            ...view,
            posts: view.posts.map((post) =>
              post.discussionId === discussionId ? { ...post, votes, youVoted: voted } : post,
            ),
          },
        });
      return true;
    },
    async post(draft) {
      if (state.working || draft.link === undefined) return { kind: 'refused' };
      publish({ working: true, refused: false });
      let tooMany = false;
      const outcome = await run(`post:${JSON.stringify(draft)}`, async (commandId) => {
        try {
          return await scope.api.rooms.postFind({
            version: VERSION,
            commandId,
            roomId,
            title: draft.title.trim(),
            words: draft.words.trim(),
            link:
              draft.link?.kind === 'source'
                ? { kind: 'source', url: draft.link.url.trim() }
                : (draft.link as PostRoomFind['link']),
          });
        } catch (error) {
          tooMany = apiProblem(error)?.code === 'TOO_MANY_REQUESTS';
          throw error;
        }
      });
      publish({ working: false });
      if (outcome.kind === 'ended') return { kind: 'refused' };
      if (outcome.kind === 'offline') {
        publish({ offline: true });
        return { kind: 'offline' };
      }
      if (outcome.kind === 'refused') {
        await load();
        return tooMany ? { kind: 'rate_limited' } : { kind: 'refused' };
      }
      await load();
      const { discussionId, result } = outcome.value;
      return { kind: result, discussionId };
    },
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
