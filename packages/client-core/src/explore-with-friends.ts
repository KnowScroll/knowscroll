import type { ContentThreadRef, ConversationContentRef, PublicPersonRef } from '@knowscroll/contracts';
import { MAX_THREAD_FRIENDS } from '@knowscroll/contracts';
import type { AccountScope } from './account-scope';
import { talkFailure } from './talk-failure';

const VERSION = 'content-thread.v1' as const;
const FRIEND_PAGES_VERSION = 'friend-pages.v2' as const;
const CONVERSATIONS_VERSION = 'direct-conversation.v1' as const;
const FRIENDS_PAGE = 50;
const MAX_FRIEND_PAGES = 4;
const NAME_LIMIT = 80;

export type CreateStatus =
  | { readonly status: 'idle' }
  | { readonly status: 'creating' }
  /** "Created" is shown only after the server's receipt. */
  | { readonly status: 'created'; readonly thread: ContentThreadRef }
  /** No answer: the identical command is kept, so Retry cannot make a second thread. */
  | { readonly status: 'unconfirmed' }
  | { readonly status: 'unavailable' }
  | { readonly status: 'failed' };

export interface ExploreWithFriendsState {
  readonly friends: {
    readonly status: 'loading' | 'ready' | 'failed';
    readonly items: readonly PublicPersonRef[];
    /** How many of the first `items` the person already talks to ("Recent"); the rest are other friends. */
    readonly recentCount: number;
  };
  /** Chosen people, by public person ID, in the order they were chosen. */
  readonly selected: readonly string[];
  readonly name: string;
  readonly create: CreateStatus;
}

export interface ExploreWithFriendsSession {
  readonly getState: () => ExploreWithFriendsState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly loadFriends: () => Promise<void>;
  /** Adds or removes a person; locked while a create's outcome is known or unknown; at most the contract's limit. */
  readonly toggle: (personId: string) => void;
  readonly setName: (name: string) => void;
  /** Creates the thread; calling it again after an unknown outcome retries the same command. */
  readonly create: () => Promise<void>;
}

export interface ExploreWithFriendsOptions {
  readonly scope: AccountScope;
  /** The exact revision the thread starts from. */
  readonly root: ConversationContentRef;
  readonly newId: () => string;
}

/**
 * The state behind "Explore with friends" (H01): who the person can ask, who they chose and the one
 * create command. Choosing people or seeing the list gives no evidence of anything and tells nobody.
 * The create command's ID is minted once per intent and reused by every retry, so a retry after an
 * unknown outcome returns the same thread instead of making another.
 */
export function createExploreWithFriends(options: ExploreWithFriendsOptions): ExploreWithFriendsSession {
  const { scope, root, newId } = options;
  const listeners = new Set<() => void>();
  let state: ExploreWithFriendsState = {
    friends: { status: 'loading', items: [], recentCount: 0 },
    selected: [],
    name: '',
    create: { status: 'idle' },
  };
  let intent: { readonly commandId: string; readonly body: string } | undefined;

  function publish(patch: Partial<ExploreWithFriendsState>): void {
    if (!scope.active) return;
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  }

  /** Friends, the people the person talks to first (newest activity first), then the rest. */
  async function readFriends(): Promise<Pick<ExploreWithFriendsState['friends'], 'items' | 'recentCount'>> {
    const recent: string[] = [];
    const inbox = await scope.api.conversations.inbox({ version: CONVERSATIONS_VERSION, readId: newId(), limit: 50 });
    if (inbox.status === 'ready')
      for (const item of inbox.items) if (item.ended !== true) recent.push(item.peer.personId);
    const friends = new Map<string, PublicPersonRef>();
    let cursor: Parameters<typeof scope.api.friendPages.friends>[0]['cursor'];
    for (let pages = 0; pages < MAX_FRIEND_PAGES; pages++) {
      const page = await scope.api.friendPages.friends({
        version: FRIEND_PAGES_VERSION,
        requestId: newId(),
        filter: 'friends',
        limit: FRIENDS_PAGE,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const item of page.items) if (item.state === 'friends') friends.set(item.peer.personId, item.peer);
      cursor = page.next;
      if (cursor === undefined) break;
    }
    const first = recent.flatMap((personId) => friends.get(personId) ?? []);
    return {
      items: [...first, ...[...friends.values()].filter((friend) => !recent.includes(friend.personId))],
      recentCount: first.length,
    };
  }

  const locked = () => state.create.status === 'creating' || state.create.status === 'unconfirmed';

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    async loadFriends() {
      try {
        publish({ friends: { ...state.friends, status: 'loading' } });
        publish({ friends: { status: 'ready', ...(await readFriends()) } });
      } catch (error) {
        if (talkFailure(error) !== 'ended') publish({ friends: { status: 'failed', items: [], recentCount: 0 } });
      }
    },
    toggle(personId) {
      if (locked() || state.create.status === 'created') return;
      if (state.selected.includes(personId)) publish({ selected: state.selected.filter((id) => id !== personId) });
      else if (state.selected.length < MAX_THREAD_FRIENDS) publish({ selected: [...state.selected, personId] });
    },
    setName(name) {
      if (!locked()) publish({ name: name.slice(0, NAME_LIMIT) });
    },
    async create() {
      if (state.selected.length === 0 || state.create.status === 'creating' || state.create.status === 'created')
        return;
      const name = state.name.trim();
      const body = JSON.stringify([state.selected, name]);
      // A different choice is a different intent; the same choice after an unknown outcome is the same command.
      if (intent?.body !== body) intent = { commandId: newId(), body };
      publish({ create: { status: 'creating' } });
      try {
        const created = await scope.api.threads.create({
          version: VERSION,
          commandId: intent.commandId,
          root,
          friendPersonIds: [...state.selected],
          ...(name === '' ? {} : { name }),
        });
        intent = undefined;
        publish({ create: { status: 'created', thread: created.thread } });
      } catch (error) {
        const kind = talkFailure(error);
        if (kind === 'ended') return;
        // A refusal is a definite no (the whole command is unavailable, and nothing says who); anything
        // else may have been stored, so the same command stays for a retry.
        if (kind === 'unavailable') intent = undefined;
        publish({
          create: { status: kind === 'unavailable' ? 'unavailable' : kind === 'offline' ? 'unconfirmed' : 'failed' },
        });
      }
    },
  };
}
