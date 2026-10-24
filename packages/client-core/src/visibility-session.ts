import type { OwnPresencePreference, PublicPersonRef, SharingVisibility } from '@knowscroll/contracts';
import type { AccountScope } from './account-scope';
import { talkFailure } from './talk-failure';

type SetVisibilityBody = Parameters<AccountScope['api']['sharing']['setVisibility']>[0];

const VERSION = 'sharing.v1' as const;
const FRIEND_PAGES_VERSION = 'friend-pages.v2' as const;
const FRIENDS_PAGE = 50;
const MAX_FRIEND_PAGES = 4;

export type AudienceMode = 'nobody' | 'chosen_friends' | 'all_friends';
export type PresencePreference = OwnPresencePreference['preference'];

/** What the person has chosen on the page, which may be one step ahead of what the server has confirmed. */
export interface VisibilityDraft {
  readonly mode: AudienceMode;
  /** Public person IDs; only meaningful while `mode` is `chosen_friends`. */
  readonly friendIds: readonly string[];
  readonly systemIds: readonly string[];
}

/** F02's save states: a change is saving, saved or failed (with a retry). */
export type VisibilitySave =
  | { readonly status: 'idle' }
  | { readonly status: 'saving' }
  | { readonly status: 'saved' }
  | { readonly status: 'failed'; readonly reason: 'offline' | 'stale' | 'failed' };

export interface VisibilityState {
  readonly load: 'loading' | 'ready' | 'unavailable';
  /** The last settings the server confirmed. Systems come with the person's own words. */
  readonly confirmed: SharingVisibility | undefined;
  readonly presence: OwnPresencePreference | undefined;
  readonly draft: VisibilityDraft | undefined;
  readonly friends: {
    readonly status: 'idle' | 'loading' | 'ready' | 'failed';
    readonly items: readonly PublicPersonRef[];
  };
  readonly save: VisibilitySave;
}

export interface VisibilitySession {
  readonly getState: () => VisibilityState;
  readonly subscribe: (listener: () => void) => () => void;
  /** Reads the settings, the availability choice and the friends the person can choose from. */
  readonly load: () => Promise<void>;
  /** Choosing "Friends I choose" with no one chosen yet shares with nobody until a friend is ticked. */
  readonly setAudience: (mode: AudienceMode) => Promise<void>;
  readonly toggleFriend: (personId: string) => Promise<void>;
  readonly toggleSystem: (systemId: string) => Promise<void>;
  readonly setPresence: (preference: PresencePreference) => Promise<void>;
  /** After a failed save: sends what is on the page again, from the server's current revision. */
  readonly retry: () => Promise<void>;
}

export interface VisibilitySessionOptions {
  readonly scope: AccountScope;
  readonly newId: () => string;
}

const failureOf = (kind: ReturnType<typeof talkFailure>): 'offline' | 'stale' | 'failed' =>
  kind === 'stale' ? 'stale' : kind === 'offline' ? 'offline' : 'failed';

const draftOf = (confirmed: SharingVisibility): VisibilityDraft => ({
  mode: confirmed.audience.mode,
  friendIds: confirmed.audience.mode === 'chosen_friends' ? confirmed.audience.personIds : [],
  systemIds: confirmed.systems.filter((system) => system.shared).map((system) => system.systemId),
});

/**
 * The state behind F02 "Sharing & visibility": who may visit, which systems they see, and whether
 * friends see "Online" or "Recently active". Every change is one command that carries the whole page,
 * so there is no half-saved audience. Changes made while a save is in flight are folded into one
 * following save. A save that fails keeps the page as the person left it and offers Retry; a revision
 * the server has moved on from rereads the settings first, so a change made on another device is
 * never silently overwritten.
 *
 * Nothing here is consumption evidence, and nothing is told to the people whose access changes.
 */
export function createVisibilitySession(options: VisibilitySessionOptions): VisibilitySession {
  const { scope, newId } = options;
  const listeners = new Set<() => void>();
  let state: VisibilityState = {
    load: 'loading',
    confirmed: undefined,
    presence: undefined,
    draft: undefined,
    friends: { status: 'idle', items: [] },
    save: { status: 'idle' },
  };
  let saving: Promise<void> | undefined;
  let dirty = false;
  let failedPresence: PresencePreference | undefined;

  function publish(patch: Partial<VisibilityState>): void {
    if (!scope.active) return;
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  }

  async function readFriends(): Promise<readonly PublicPersonRef[]> {
    const friends: PublicPersonRef[] = [];
    let cursor: Parameters<typeof scope.api.friendPages.friends>[0]['cursor'];
    for (let pages = 0; pages < MAX_FRIEND_PAGES; pages += 1) {
      const page = await scope.api.friendPages.friends({
        version: FRIEND_PAGES_VERSION,
        requestId: newId(),
        filter: 'friends',
        limit: FRIENDS_PAGE,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const item of page.items) if (item.state === 'friends') friends.push(item.peer);
      cursor = page.next;
      if (cursor === undefined) break;
    }
    return friends.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  async function load(): Promise<void> {
    publish({ load: state.confirmed === undefined ? 'loading' : state.load });
    try {
      const [confirmed, presence] = [
        await scope.api.sharing.visibility({}),
        await scope.api.sharing.presencePreference({}),
      ];
      publish({ load: 'ready', confirmed, presence, draft: state.draft ?? draftOf(confirmed) });
    } catch (error) {
      if (talkFailure(error) !== 'ended') publish({ load: state.confirmed === undefined ? 'unavailable' : 'ready' });
      return;
    }
    if (state.friends.status === 'idle' || state.friends.status === 'failed') {
      publish({ friends: { status: 'loading', items: state.friends.items } });
      try {
        publish({ friends: { status: 'ready', items: await readFriends() } });
      } catch (error) {
        if (talkFailure(error) !== 'ended') publish({ friends: { status: 'failed', items: [] } });
      }
    }
  }

  /** One save of the whole page; the draft is what the person sees, the confirmed revision is the server's. */
  async function saveOnce(): Promise<void> {
    const { confirmed, draft } = state;
    if (confirmed === undefined || draft === undefined) return;
    const chosen = draft.mode === 'chosen_friends' ? draft.friendIds : [];
    // A chosen list with no one in it shares with nobody; the draft keeps the radio where the person put it.
    const audience: SetVisibilityBody['audience'] =
      draft.mode === 'all_friends'
        ? { mode: 'all_friends' }
        : draft.mode === 'chosen_friends' && chosen.length > 0
          ? { mode: 'chosen_friends', personIds: [...chosen] }
          : { mode: 'nobody' };
    const sameSystems =
      confirmed.systems.filter((system) => system.shared).length === draft.systemIds.length &&
      confirmed.systems.every((system) => system.shared === draft.systemIds.includes(system.systemId));
    const sameAudience =
      confirmed.audience.mode === audience.mode &&
      (confirmed.audience.mode !== 'chosen_friends' ||
        (audience.mode === 'chosen_friends' &&
          confirmed.audience.personIds.length === audience.personIds.length &&
          confirmed.audience.personIds.every((id) => audience.personIds.includes(id))));
    // Nothing the server does not already have: no command, so no needless revision and no "saved".
    if (sameSystems && sameAudience) return;
    publish({ save: { status: 'saving' } });
    try {
      await scope.api.sharing.setVisibility({
        version: VERSION,
        commandId: newId(),
        expectedVisibilityRevision: confirmed.visibilityRevision,
        audience,
        sharedSystemIds: [...draft.systemIds],
      });
      const reread = await scope.api.sharing.visibility({});
      publish({ confirmed: reread, save: { status: 'saved' } });
    } catch (error) {
      const kind = talkFailure(error);
      if (kind === 'ended') return;
      publish({ save: { status: 'failed', reason: failureOf(kind) } });
      // A stale revision or a refused change means the server has moved on (another device, a friend
      // who is no longer one): show what it holds, not our old page. No answer keeps the page for Retry.
      if (kind !== 'offline') {
        try {
          const reread = await scope.api.sharing.visibility({});
          publish({ confirmed: reread, draft: draftOf(reread) });
        } catch {
          // The page stays as it was; Retry rereads again.
        }
      }
    }
  }

  function requestSave(): Promise<void> {
    if (saving !== undefined) {
      dirty = true;
      return saving;
    }
    saving = (async () => {
      do {
        dirty = false;
        await saveOnce();
      } while (dirty && state.save.status !== 'failed' && scope.active);
    })().finally(() => {
      saving = undefined;
    });
    return saving;
  }

  function change(next: Partial<VisibilityDraft>): Promise<void> {
    if (state.draft === undefined) return Promise.resolve();
    publish({ draft: { ...state.draft, ...next } });
    return requestSave();
  }

  async function setPresence(preference: PresencePreference): Promise<void> {
    const current = state.presence;
    if (current === undefined || current.preference === preference) return;
    publish({ save: { status: 'saving' } });
    failedPresence = undefined;
    try {
      await scope.api.sharing.setPresencePreference({
        version: VERSION,
        commandId: newId(),
        expectedPresencePreferenceRevision: current.presencePreferenceRevision,
        preference,
      });
      publish({ presence: await scope.api.sharing.presencePreference({}), save: { status: 'saved' } });
    } catch (error) {
      const kind = talkFailure(error);
      if (kind === 'ended') return;
      publish({ save: { status: 'failed', reason: failureOf(kind) } });
      if (kind === 'offline') failedPresence = preference;
      else
        try {
          publish({ presence: await scope.api.sharing.presencePreference({}) });
        } catch {
          // Shown as it was.
        }
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    load,
    setAudience: (mode) => change({ mode }),
    toggleFriend(personId) {
      const draft = state.draft;
      if (draft === undefined) return Promise.resolve();
      const friendIds = draft.friendIds.includes(personId)
        ? draft.friendIds.filter((id) => id !== personId)
        : [...draft.friendIds, personId];
      return change({ mode: 'chosen_friends', friendIds });
    },
    toggleSystem(systemId) {
      const draft = state.draft;
      if (draft === undefined) return Promise.resolve();
      const systemIds = draft.systemIds.includes(systemId)
        ? draft.systemIds.filter((id) => id !== systemId)
        : [...draft.systemIds, systemId];
      return change({ systemIds });
    },
    setPresence,
    async retry() {
      if (failedPresence !== undefined) {
        const preference = failedPresence;
        try {
          publish({ presence: await scope.api.sharing.presencePreference({}) });
        } catch {
          publish({ save: { status: 'failed', reason: 'offline' } });
          return;
        }
        await setPresence(preference);
        return;
      }
      // Start from what the server has now, with the page as the person left it.
      try {
        publish({ confirmed: await scope.api.sharing.visibility({}) });
      } catch {
        publish({ save: { status: 'failed', reason: 'offline' } });
        return;
      }
      await requestSave();
    },
  };
}
