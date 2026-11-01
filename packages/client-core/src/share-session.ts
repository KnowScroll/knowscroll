import type {
  ConversationContentRef,
  DirectConversationRef,
  OwnContentShares,
  PublicPersonRef,
} from '@knowscroll/contracts';
import type { AccountScope } from './account-scope';
import { talkFailure } from './talk-failure';

const VERSION = 'direct-conversation.v1' as const;
const SHARE_VERSION = 'content-share.v1' as const;
const FRIEND_PAGES_VERSION = 'friend-pages.v2' as const;
const FRIENDS_PAGE = 50;
const MAX_FRIEND_PAGES = 4;
const MAX_NOTE = 500;

/**
 * The public links an account scope has made, by exact revision. A link's token is a bearer secret the server keeps only as
 * a hash, so the only copy is the one the creating response carried: held here, in memory and with the scope, so that
 * "Copy link" a second time copies the link that is already live instead of making another share.
 */
interface MadeLink {
  readonly url: string;
  readonly shareId: string;
}
const madeLinks = new WeakMap<AccountScope, Map<string, MadeLink>>();
const linkKey = (target: ConversationContentRef) => `${target.assetId}:${String(target.assetRevision)}`;

/** A friend the person can send to, with the open conversation when there is one. */
export interface ShareTarget {
  readonly person: PublicPersonRef;
  readonly conversation: DirectConversationRef | undefined;
  /** The friendship revision the person's view holds; starting a conversation needs it. */
  readonly pairRevision: number;
}

export type SendStatus =
  | { readonly status: 'idle' }
  | { readonly status: 'sending' }
  /** "Sent" is shown only after the server's receipt. */
  | {
      readonly status: 'sent';
      readonly target: ShareTarget;
      readonly conversation: DirectConversationRef;
      /**
       * For a challenge (D-245): whether the sender's own pick was kept. `paused`: recording is paused, so the pick is
       * not saved (D-083). `not_kept`: the pick did not get through; the card in the conversation still lets them call.
       */
      readonly pick?: 'kept' | 'paused' | 'not_kept';
    }
  /** No answer: the identical command is kept, so Retry cannot send twice. */
  | { readonly status: 'unconfirmed' }
  | { readonly status: 'unavailable' }
  | { readonly status: 'failed' };

export type LinkStatus =
  | { readonly status: 'idle' }
  | { readonly status: 'creating' }
  | { readonly status: 'ready'; readonly url: string; readonly shareId: string; readonly copied: boolean }
  | { readonly status: 'stopping' }
  | { readonly status: 'stopped' }
  | { readonly status: 'failed' };

export interface ShareState {
  readonly targets: { readonly status: 'loading' | 'ready' | 'failed'; readonly items: readonly ShareTarget[] };
  readonly selected: string | undefined;
  readonly note: string;
  /** For a challenge: the option the sender calls, a zero-based index; none until they choose (D-245). */
  readonly pick: number | undefined;
  readonly send: SendStatus;
  readonly link: LinkStatus;
}

export interface ShareSession {
  readonly getState: () => ShareState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly loadTargets: () => Promise<void>;
  /** Single choice, by person ID. Locked while a send's outcome is unknown. */
  readonly select: (personId: string | undefined) => void;
  readonly setNote: (note: string) => void;
  /** For a challenge: the sender's own call. */
  readonly setPick: (option: number | undefined) => void;
  /** Starts the conversation if needed, then sends the card. Calling it again retries the same command. */
  readonly send: () => Promise<void>;
  /**
   * Copies the person's live public link to this exact revision, making one only when there is none. The link is a bearer
   * secret held only in memory, so a link made before the app was reloaded cannot be copied again and a new one is made.
   */
  readonly copyLink: () => Promise<void>;
  /** Revokes the link just made. */
  readonly stopLink: () => Promise<void>;
}

export interface ShareSessionOptions {
  readonly scope: AccountScope;
  /** The exact revision shared. */
  readonly target: ConversationContentRef;
  /**
   * Makes the card a challenge for this stop (a Call it or the Final call) of the revision (D-245): the friend is asked to
   * call it, and the sender locks their own pick after the card is sent. No pick travels with the card.
   */
  readonly challenge?: { readonly stopId: string } | undefined;
  /** The origin links are built on (the app's own origin, where `/s/*` reaches the API). */
  readonly origin: string;
  readonly newId: () => string;
  /** Puts text on the clipboard; rejects when the platform refuses. */
  readonly copyText: (text: string) => Promise<void>;
}

/**
 * The state behind the share sheet (H01): who the person can send to, one send with its receipt, and
 * one public link. External delivery is never claimed: copying a link or opening the system sheet
 * is the person's own act, and only the server's receipt says a message was sent.
 *
 * Every command's ID is minted once per intent and reused by each retry. An unknown outcome
 * keeps the intent (and locks the choices) until it is retried or the sheet closes. Nothing here
 * records consumption: choosing a friend, sending and copying are not encounters.
 */
export function createShareSession(options: ShareSessionOptions): ShareSession {
  const { scope, target, challenge, origin, newId, copyText } = options;
  const listeners = new Set<() => void>();
  let state: ShareState = {
    targets: { status: 'loading', items: [] },
    selected: undefined,
    note: '',
    pick: undefined,
    send: { status: 'idle' },
    link: { status: 'idle' },
  };
  let sendIntent: { readonly startId: string; readonly sendId: string } | undefined;
  let linkIntent: string | undefined;

  function publish(patch: Partial<ShareState>): void {
    if (!scope.active) return;
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  }

  const locked = () => state.send.status === 'sending' || state.send.status === 'unconfirmed';

  async function readTargets(): Promise<readonly ShareTarget[]> {
    const conversations = new Map<string, DirectConversationRef>();
    const inbox = await scope.api.conversations.inbox({ version: VERSION, readId: newId(), limit: 50 });
    const recent: string[] = [];
    if (inbox.status === 'ready')
      for (const item of inbox.items)
        if (item.ended !== true) {
          conversations.set(item.peer.personId, item.conversation);
          recent.push(item.peer.personId);
        }
    const friends = new Map<string, ShareTarget>();
    let cursor: Parameters<typeof scope.api.friendPages.friends>[0]['cursor'];
    for (let pages = 0; pages < MAX_FRIEND_PAGES; pages++) {
      const page = await scope.api.friendPages.friends({
        version: FRIEND_PAGES_VERSION,
        requestId: newId(),
        filter: 'friends',
        limit: FRIENDS_PAGE,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const item of page.items)
        if (item.state === 'friends')
          friends.set(item.peer.personId, {
            person: item.peer,
            conversation: conversations.get(item.peer.personId),
            pairRevision: item.pairRevision,
          });
      cursor = page.next;
      if (cursor === undefined) break;
    }
    // People the person talks to come first, in inbox order (newest activity first).
    const first = recent.flatMap((personId) => friends.get(personId) ?? []);
    const rest = [...friends.values()].filter((friend) => !recent.includes(friend.person.personId));
    return [...first, ...rest];
  }

  async function loadTargets(): Promise<void> {
    try {
      publish({ targets: { status: 'loading', items: state.targets.items } });
      publish({ targets: { status: 'ready', items: await readTargets() } });
    } catch (error) {
      if (talkFailure(error) !== 'ended') publish({ targets: { status: 'failed', items: [] } });
    }
  }

  /** The sender's own call on the card just sent. A pick that cannot be kept never undoes the send. */
  async function lockOwnPick(
    conversation: DirectConversationRef,
    messageId: string,
    option: number,
  ): Promise<'kept' | 'paused' | 'not_kept'> {
    if (scope.recording?.getState().policy?.on === false) return 'paused';
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const recordingGeneration = await scope.recording?.generation();
        if (recordingGeneration === undefined) return 'not_kept';
        const answer = await scope.api.conversations.lockChallenge({
          version: VERSION,
          conversation,
          messageId,
          option,
          recordingGeneration,
        });
        if (answer.recorded) return 'kept';
        if (answer.reason === 'recording_paused') return 'paused';
        // The policy moved on since this device read it: read it again and send the same pick once more.
        await scope.recording?.refresh();
      }
    } catch {
      return 'not_kept';
    }
    return 'not_kept';
  }

  async function send(): Promise<void> {
    const chosen = state.targets.items.find((candidate) => candidate.person.personId === state.selected);
    if (!chosen || state.send.status === 'sending' || state.send.status === 'sent') return;
    const intent = (sendIntent ??= { startId: newId(), sendId: newId() });
    publish({ send: { status: 'sending' } });
    const note = state.note.trim();
    try {
      const conversation =
        chosen.conversation ??
        (
          await scope.api.conversations.start({
            version: VERSION,
            commandId: intent.startId,
            peerPersonId: chosen.person.personId,
            expectedPairRevision: chosen.pairRevision,
          })
        ).conversation;
      const accepted = await scope.api.conversations.send({
        version: VERSION,
        commandId: intent.sendId,
        conversation,
        body: {
          kind: 'content',
          target,
          ...(note === '' ? {} : { note }),
          ...(challenge === undefined ? {} : { challenge }),
        },
      });
      sendIntent = undefined;
      const pick =
        challenge === undefined || state.pick === undefined
          ? undefined
          : await lockOwnPick(conversation, accepted.messageId, state.pick);
      publish({ send: { status: 'sent', target: chosen, conversation, ...(pick === undefined ? {} : { pick }) } });
    } catch (error) {
      const kind = talkFailure(error);
      if (kind === 'ended') return;
      // A refusal or a stale friendship view is a definite no; anything else may have been stored,
      // so the same command stays for a retry.
      if (kind === 'unavailable' || kind === 'stale') sendIntent = undefined;
      publish({
        send: { status: kind === 'unavailable' ? 'unavailable' : kind === 'offline' ? 'unconfirmed' : 'failed' },
      });
      if (kind === 'stale') void loadTargets();
    }
  }

  /** The link this scope already made for this revision, if the server still answers for it. */
  async function liveLink(): Promise<MadeLink | undefined> {
    const made = madeLinks.get(scope)?.get(linkKey(target));
    if (made === undefined) return undefined;
    const own = await scope.api.contentShares.list({ version: SHARE_VERSION, readId: newId() });
    if (own.items.some((item) => item.shareId === made.shareId)) return made;
    madeLinks.get(scope)?.delete(linkKey(target));
    return undefined;
  }

  function rememberLink(link: MadeLink): void {
    const links = madeLinks.get(scope) ?? new Map<string, MadeLink>();
    links.set(linkKey(target), link);
    madeLinks.set(scope, links);
  }

  async function createLink(): Promise<void> {
    if (state.link.status === 'creating' || state.link.status === 'stopping') return;
    publish({ link: { status: 'creating' } });
    try {
      const live = await liveLink();
      if (live !== undefined) {
        const copied = await copyText(live.url).then(
          () => true,
          () => false,
        );
        publish({ link: { status: 'ready', url: live.url, shareId: live.shareId, copied } });
        return;
      }
      let attempts = 0;
      for (;;) {
        const commandId = (linkIntent ??= newId());
        const made = await scope.api.contentShares.create({
          version: SHARE_VERSION,
          commandId,
          target,
          audience: { kind: 'public_metadata' },
        });
        if (made.delivery.status === 'available') {
          const url = `${origin}/s/${made.delivery.token}`;
          const copied = await copyText(url).then(
            () => true,
            () => false,
          );
          linkIntent = undefined;
          rememberLink({ url, shareId: made.acceptance.shareId });
          publish({ link: { status: 'ready', url, shareId: made.acceptance.shareId, copied } });
          return;
        }
        // A retry of a command whose answer was lost: the token cannot be recovered. The person asked
        // again on purpose, so stop that link and make a new one.
        if (++attempts > 1) throw new Error('SHARE_TOKEN_LOST');
        await scope.api.contentShares.revoke({
          version: SHARE_VERSION,
          commandId: newId(),
          shareId: made.acceptance.shareId,
        });
        linkIntent = undefined;
      }
    } catch (error) {
      if (talkFailure(error) !== 'ended') publish({ link: { status: 'failed' } });
    }
  }

  async function stopLink(): Promise<void> {
    const current = state.link;
    if (current.status !== 'ready') return;
    publish({ link: { status: 'stopping' } });
    try {
      await scope.api.contentShares.revoke({ version: SHARE_VERSION, commandId: newId(), shareId: current.shareId });
      madeLinks.get(scope)?.delete(linkKey(target));
      publish({ link: { status: 'stopped' } });
    } catch (error) {
      if (talkFailure(error) !== 'ended') publish({ link: current });
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    loadTargets,
    select(personId) {
      if (locked() || state.send.status === 'sent') return;
      sendIntent = undefined;
      publish({ selected: personId, send: { status: 'idle' } });
    },
    setPick(option) {
      if (locked() || state.send.status === 'sent') return;
      publish({ pick: option });
    },
    setNote(note) {
      if (locked() || state.send.status === 'sent') return;
      // A new note is a new message: the old command, if it failed for certain, is not reused.
      sendIntent = undefined;
      publish({ note: note.slice(0, MAX_NOTE) });
    },
    send,
    copyLink: createLink,
    stopLink,
  };
}

/** The person's own live links, for the privacy screen: see them and stop them. */
export interface SharedLinksState {
  readonly status: 'loading' | 'ready' | 'failed';
  readonly items: OwnContentShares['items'];
  /** The share being stopped, if any. */
  readonly stopping: string | undefined;
}

export interface SharedLinksSession {
  readonly getState: () => SharedLinksState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly refresh: () => Promise<void>;
  readonly stop: (shareId: string) => Promise<void>;
}

export function createSharedLinksSession(options: {
  readonly scope: AccountScope;
  readonly newId: () => string;
}): SharedLinksSession {
  const { scope, newId } = options;
  const listeners = new Set<() => void>();
  let state: SharedLinksState = { status: 'loading', items: [], stopping: undefined };
  const publish = (patch: Partial<SharedLinksState>) => {
    if (!scope.active) return;
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  };
  async function refresh(): Promise<void> {
    try {
      const own = await scope.api.contentShares.list({ version: SHARE_VERSION, readId: newId() });
      publish({ status: 'ready', items: own.items });
    } catch (error) {
      if (talkFailure(error) !== 'ended') publish({ status: 'failed' });
    }
  }
  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    refresh,
    async stop(shareId) {
      if (state.stopping !== undefined) return;
      publish({ stopping: shareId });
      try {
        await scope.api.contentShares.revoke({ version: SHARE_VERSION, commandId: newId(), shareId });
        publish({ stopping: undefined, items: state.items.filter((item) => item.shareId !== shareId) });
      } catch (error) {
        publish({ stopping: undefined });
        if (talkFailure(error) !== 'ended') await refresh();
      }
    },
  };
}
