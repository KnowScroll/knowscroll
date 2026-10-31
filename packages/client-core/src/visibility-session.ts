import type { OwnPresencePreference, OwnReadReceipts, PublicPersonRef, SharingVisibility } from '@knowscroll/contracts';
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
  /** SEEN (D-066): whether the people the person talks with see how far they have read. */
  readonly readReceipts: OwnReadReceipts | undefined;
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
  /** Reads the settings, the availability choice, the SEEN switch and the friends the person can choose from. */
  readonly load: () => Promise<void>;
  /** Choosing "Friends I choose" with no one chosen yet shares with nobody until a friend is ticked. */
  readonly setAudience: (mode: AudienceMode) => Promise<void>;
  readonly toggleFriend: (personId: string) => Promise<void>;
  readonly toggleSystem: (systemId: string) => Promise<void>;
  readonly setPresence: (preference: PresencePreference) => Promise<void>;
  /**
   * Turns SEEN on or off. It is its own command with its own revision, and works both ways: hide yours, and
   * you do not see theirs.
   */
  readonly setReadReceipts: (shared: boolean) => Promise<void>;
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

type SetAudience = SetVisibilityBody['audience'];

/**
 * The audience a draft asks the server for. A chosen list with no one in it shares with nobody; the
 * draft keeps the radio where the person put it.
 */
function audienceOfDraft(draft: VisibilityDraft): SetAudience {
  if (draft.mode === 'all_friends') return { mode: 'all_friends' };
  if (draft.mode === 'chosen_friends' && draft.friendIds.length > 0)
    return { mode: 'chosen_friends', personIds: [...draft.friendIds] };
  return { mode: 'nobody' };
}

/** Whether the server already holds exactly this audience and these shared systems. */
function alreadyConfirmed(confirmed: SharingVisibility, audience: SetAudience, systemIds: readonly string[]): boolean {
  const sameSystems =
    confirmed.systems.filter((system) => system.shared).length === systemIds.length &&
    confirmed.systems.every((system) => system.shared === systemIds.includes(system.systemId));
  const sameAudience =
    confirmed.audience.mode === audience.mode &&
    (confirmed.audience.mode !== 'chosen_friends' ||
      (audience.mode === 'chosen_friends' &&
        confirmed.audience.personIds.length === audience.personIds.length &&
        confirmed.audience.personIds.every((id) => audience.personIds.includes(id))));
  return sameSystems && sameAudience;
}

const toggled = (list: readonly string[], id: string): string[] =>
  list.includes(id) ? list.filter((item) => item !== id) : [...list, id];

/** The person's friends, by name, as the picker lists them. */
async function readFriends(scope: AccountScope, newId: () => string): Promise<readonly PublicPersonRef[]> {
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

/** What a single-setting saver needs of the session: the latest state, and a way to change it. */
interface SessionHost {
  readonly current: () => VisibilityState;
  readonly publish: (patch: Partial<VisibilityState>) => void;
}

/** One setting the page saves on its own, apart from the audience: what to read, what to send, where it lives. */
interface SettingSpec<Value, Setting> {
  readonly read: () => Promise<Setting>;
  readonly write: (value: Value, current: Setting) => Promise<unknown>;
  readonly held: (state: VisibilityState) => Setting | undefined;
  readonly valueOf: (setting: Setting) => Value;
  readonly patch: (setting: Setting) => Partial<VisibilityState>;
}

/**
 * Saving one setting that has its own command and revision (the availability choice, SEEN). It keeps the
 * one choice that failed for want of a connection so Retry can send it again, from the server's current
 * revision.
 */
function createSettingSaver<Value, Setting>(host: SessionHost, spec: SettingSpec<Value, Setting>) {
  let failedWhileOffline: { readonly value: Value } | undefined;

  async function set(value: Value): Promise<void> {
    const current = spec.held(host.current());
    if (current === undefined || spec.valueOf(current) === value) return;
    host.publish({ save: { status: 'saving' } });
    failedWhileOffline = undefined;
    try {
      await spec.write(value, current);
      host.publish({ ...spec.patch(await spec.read()), save: { status: 'saved' } });
    } catch (error) {
      const kind = talkFailure(error);
      if (kind === 'ended') return;
      host.publish({ save: { status: 'failed', reason: failureOf(kind) } });
      if (kind === 'offline') failedWhileOffline = { value };
      else
        try {
          host.publish(spec.patch(await spec.read()));
        } catch {
          // Shown as it was.
        }
    }
  }

  /** Sends the choice that was lost offline, from the server's current revision. False when there is none. */
  async function retry(): Promise<boolean> {
    if (failedWhileOffline === undefined) return false;
    const { value } = failedWhileOffline;
    try {
      host.publish(spec.patch(await spec.read()));
    } catch {
      host.publish({ save: { status: 'failed', reason: 'offline' } });
      return true;
    }
    await set(value);
    return true;
  }

  return { set, retry };
}

/**
 * The state behind F02 "Sharing & visibility": who may visit, which systems they see, whether
 * friends see "Online" or "Recently active", and whether the people the person talks with see SEEN. Every
 * change is one command that carries the whole page, so there is no half-saved audience. Changes made while a save is in flight are folded into one
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
    readReceipts: undefined,
    draft: undefined,
    friends: { status: 'idle', items: [] },
    save: { status: 'idle' },
  };
  let saving: Promise<void> | undefined;
  let dirty = false;
  const host: SessionHost = { current: () => state, publish };
  const presence = createSettingSaver<PresencePreference, OwnPresencePreference>(host, {
    read: () => scope.api.sharing.presencePreference({}),
    write: (preference, current) =>
      scope.api.sharing.setPresencePreference({
        version: VERSION,
        commandId: newId(),
        expectedPresencePreferenceRevision: current.presencePreferenceRevision,
        preference,
      }),
    held: (held) => held.presence,
    valueOf: (setting) => setting.preference,
    patch: (setting) => ({ presence: setting }),
  });
  const readReceipts = createSettingSaver<boolean, OwnReadReceipts>(host, {
    read: () => scope.api.sharing.readReceipts({}),
    write: (shared, current) =>
      scope.api.sharing.setReadReceipts({
        version: VERSION,
        commandId: newId(),
        expectedReadReceiptsRevision: current.readReceiptsRevision,
        shared,
      }),
    held: (held) => held.readReceipts,
    valueOf: (setting) => setting.shared,
    patch: (setting) => ({ readReceipts: setting }),
  });

  function publish(patch: Partial<VisibilityState>): void {
    if (!scope.active) return;
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  }

  async function load(): Promise<void> {
    publish({ load: state.confirmed === undefined ? 'loading' : state.load });
    try {
      const confirmed = await scope.api.sharing.visibility({});
      const presence = await scope.api.sharing.presencePreference({});
      const readReceipts = await scope.api.sharing.readReceipts({});
      publish({ load: 'ready', confirmed, presence, readReceipts, draft: state.draft ?? draftOf(confirmed) });
    } catch (error) {
      if (talkFailure(error) !== 'ended') publish({ load: state.confirmed === undefined ? 'unavailable' : 'ready' });
      return;
    }
    if (state.friends.status === 'idle' || state.friends.status === 'failed') {
      publish({ friends: { status: 'loading', items: state.friends.items } });
      try {
        publish({ friends: { status: 'ready', items: await readFriends(scope, newId) } });
      } catch (error) {
        if (talkFailure(error) !== 'ended') publish({ friends: { status: 'failed', items: [] } });
      }
    }
  }

  /** One save of the whole page; the draft is what the person sees, the confirmed revision is the server's. */
  async function saveOnce(): Promise<void> {
    const { confirmed, draft } = state;
    if (confirmed === undefined || draft === undefined) return;
    const audience = audienceOfDraft(draft);
    // Nothing the server does not already have: no command, so no needless revision and no "saved".
    if (alreadyConfirmed(confirmed, audience, draft.systemIds)) return;
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
      return change({ mode: 'chosen_friends', friendIds: toggled(draft.friendIds, personId) });
    },
    toggleSystem(systemId) {
      const draft = state.draft;
      if (draft === undefined) return Promise.resolve();
      return change({ systemIds: toggled(draft.systemIds, systemId) });
    },
    setPresence: presence.set,
    setReadReceipts: readReceipts.set,
    async retry() {
      if ((await presence.retry()) || (await readReceipts.retry())) return;
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
