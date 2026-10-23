import type { DirectConversationRef, ConversationMessage } from '@knowscroll/contracts';
import type { ApiClient } from './api-client';
import type { AccountScope } from './account-scope';
import { ScopeEndedError } from './account-scope';

export type ConversationOperation = keyof ApiClient['conversations'];
export type ConversationInput<K extends ConversationOperation> = Parameters<ApiClient['conversations'][K]>[0];
export type ConversationOutput<K extends ConversationOperation> = Awaited<ReturnType<ApiClient['conversations'][K]>>;
export type ConversationMutation = 'start' | 'send' | 'markRead' | 'mute' | 'leave';
export type ShareOperation = keyof ApiClient['contentShares'];
export type ShareInput<K extends ShareOperation> = Parameters<ApiClient['contentShares'][K]>[0];
export type ShareOutput<K extends ShareOperation> = Awaited<ReturnType<ApiClient['contentShares'][K]>>;
export type SocialFailure =
  'network' | 'invalid' | 'unavailable' | 'authority' | 'refresh_required' | 'capacity' | 'busy';
export type SocialRead<T> =
  | { readonly status: 'idle' | 'loading' }
  | { readonly status: 'ready'; readonly data: T }
  | { readonly status: 'unavailable'; readonly reason: SocialFailure };
export type SocialCommandState =
  | { readonly status: 'idle' }
  | { readonly status: 'pending' | 'unknown'; readonly operation: string; readonly commandId: string }
  | { readonly status: 'accepted'; readonly operation: string; readonly commandId: string }
  | { readonly status: 'rejected'; readonly reason: SocialFailure };
export type ConversationDraft = ConversationInput<'send'>['body'];
export type ConversationWindow = {
  readonly conversation: DirectConversationRef;
  readonly status: 'loading' | 'ready' | 'unavailable' | 'refresh_required';
  readonly reason?: SocialFailure;
  readonly peer?: Extract<ConversationOutput<'read'>, { status: 'ready' }>['peer'];
  readonly own?: Extract<ConversationOutput<'read'>, { status: 'ready' }>['own'];
  readonly latestMessageSequence: number;
  readonly messages: readonly ConversationMessage[];
  readonly historyAvailable: boolean;
  readonly catchUp: 'available' | 'more' | 'caught_up' | 'refresh_required';
};
export interface ConversationsState {
  readonly status: 'active' | 'ended';
  readonly focused: boolean;
  readonly inbox: SocialRead<ConversationOutput<'inbox'>>;
  readonly windows: readonly ConversationWindow[];
  readonly drafts: readonly { readonly conversation: DirectConversationRef; readonly body: ConversationDraft }[];
  readonly command: SocialCommandState;
  readonly recovery: SocialRead<ConversationOutput<'readOwnSend'>>;
  readonly mutationBlocked: boolean;
  readonly failure?: SocialFailure;
}
export interface ConversationsSession {
  getState(): ConversationsState;
  subscribe(listener: () => void): () => void;
  focus(active: boolean): void;
  refreshInbox(): Promise<void>;
  nextInbox(): Promise<void>;
  /** The locator must already occur in a current inbox/start/read held by this scope owner. */
  open(conversation: DirectConversationRef): Promise<void>;
  refreshConversation(conversation: DirectConversationRef): Promise<void>;
  history(conversation: DirectConversationRef): Promise<void>;
  /** Exactly one page of one captured finite change window; never automatic draining. */
  catchUp(conversation: DirectConversationRef): Promise<void>;
  setDraft(conversation: DirectConversationRef, body: ConversationDraft | undefined): void;
  send(conversation: DirectConversationRef): Promise<void>;
  /** Performs an actual fresh accepted Friends pair read, then the deliberate start. */
  start(peerPersonId: string): Promise<void>;
  markRead(conversation: DirectConversationRef, throughSequence: number): Promise<void>;
  mute(conversation: DirectConversationRef, muted: boolean): Promise<void>;
  leave(conversation: DirectConversationRef): Promise<void>;
  recoverOwnSend(conversation: DirectConversationRef): Promise<void>;
  retryCommand(): Promise<void>;
  /** Explicit loss of a confirmed inactive window/draft. Unknown commands remain pinned. */
  forgetWindow(conversation: DirectConversationRef): void;
  /** Permanent shutdown for this scope's Social owner, not view blur/unmount. */
  dispose(): void;
}
export interface ContentSharesState {
  readonly status: 'active' | 'ended';
  readonly own: SocialRead<ShareOutput<'own'>>;
  readonly resolved: SocialRead<ShareOutput<'resolve'>>;
  readonly command: SocialCommandState;
  readonly tokenAvailable: boolean;
  readonly mutationBlocked: boolean;
  readonly failure?: SocialFailure;
}
export interface ContentSharesSession {
  getState(): ContentSharesState;
  subscribe(listener: () => void): () => void;
  create(input: Omit<ShareInput<'create'>, 'version' | 'commandId'>): Promise<void>;
  readOwn(selector: ShareInput<'own'>['selector']): Promise<void>;
  resolve(token: string): Promise<void>;
  revoke(shareId: string): Promise<void>;
  retryCommand(): Promise<void>;
  /** Once-only first delivery, never an observable state/cache/URL value. */
  takeToken(): string | undefined;
  dispose(): void;
}
export const SOCIAL_LIMITS = Object.freeze({
  windows: 8,
  messages: 100,
  bodyBytes: 2 * 1024 * 1024,
  drafts: 8,
  draftCharacters: 2000,
  page: 50,
  cursorHistory: 8,
  responseBytes: 2 * 1024 * 1024,
});
export const sameSocialId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export const sameConversation = (a: DirectConversationRef, b: DirectConversationRef) =>
  sameSocialId(a.conversationId, b.conversationId) &&
  sameSocialId(a.membershipId, b.membershipId) &&
  a.membershipRevision === b.membershipRevision;
export const conversationKey = (r: DirectConversationRef) =>
  `${r.conversationId.toLowerCase()}:${r.membershipId.toLowerCase()}:${r.membershipRevision}`;
export function freezeSocial<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeSocial(child);
    Object.freeze(value);
  }
  return value;
}
/** Descriptor-only JSON validation before any accessor, parse or stringify. No normalization. */
export function socialData(value: unknown): boolean {
  let remaining = 20000;
  const ancestors = new Set<object>();
  function walk(v: unknown, depth: number): boolean {
    if (--remaining < 0 || depth > 24) return false;
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
    if (typeof v === 'number') return Number.isFinite(v);
    if (typeof v !== 'object' || ancestors.has(v)) return false;
    const array = Array.isArray(v),
      proto: unknown = Object.getPrototypeOf(v);
    if (proto !== (array ? Array.prototype : Object.prototype) && proto !== null) return false;
    const ds = Object.getOwnPropertyDescriptors(v),
      keys = Reflect.ownKeys(ds);
    if (keys.some((k) => typeof k !== 'string')) return false;
    if (array) {
      const n: unknown = ds['length']?.value;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 10000 || keys.length !== n + 1) return false;
      for (let i = 0; i < n; i++) if (!Object.hasOwn(ds, String(i))) return false;
    }
    ancestors.add(v);
    for (const k of keys) {
      if (array && k === 'length') continue;
      const d = ds[k as string];
      if (!d || !d.enumerable || !('value' in d) || !walk(d.value, depth + 1)) return false;
    }
    ancestors.delete(v);
    return true;
  }
  try {
    return walk(value, 0);
  } catch {
    return false;
  }
}
function bodyBytes(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  let total = 0;
  for (const [key, child] of Object.entries(value)) {
    if (['text', 'note'].includes(key) && typeof child === 'string') total += new TextEncoder().encode(child).length;
    else if (key === 'metadata') total += new TextEncoder().encode(JSON.stringify(child)).length;
    else total += bodyBytes(child);
  }
  return total;
}
/** One private command slot and aggregate controlled-copy budget shared by BOTH controllers. */
const owners = new WeakMap<AccountScope, ReturnType<typeof makeOwner>>();
function makeOwner(scope: AccountScope) {
  if (!scope.active || typeof scope.onEnd !== 'function') throw new ScopeEndedError();
  let ended = false,
    slot: object | undefined;
  const sizes = new Map<object, number>(),
    refs = new Map<string, DirectConversationRef>(),
    listeners = new Set<() => void>(),
    ends = new Set<{ purge: () => void; notify: () => void }>();
  let publication = 0;
  const live = () => !ended && scope.active;
  const notify = () => {
    const mine = ++publication;
    for (const listener of [...listeners]) {
      if (mine !== publication) break;
      try {
        if (listeners.has(listener)) listener();
      } catch {
        /* Consumer cannot block purge. */
      }
    }
  };
  const end = () => {
    if (ended) return;
    ended = true;
    slot = undefined;
    sizes.clear();
    refs.clear();
    const callbacks = [...ends];
    for (const callback of callbacks) {
      try {
        callback.purge();
      } catch {
        /* Purge all owners. */
      }
    }
    ends.clear();
    for (const callback of callbacks) {
      try {
        callback.notify();
      } catch {
        /* Every owner is already purged. */
      }
    }
    notify();
    listeners.clear();
  };
  scope.onEnd(end);
  return {
    scope,
    live,
    end,
    busy: () => !!slot,
    claim(token: object) {
      if (!live() || slot) return false;
      slot = token;
      notify();
      return live() && slot === token;
    },
    release(token: object) {
      if (slot === token) {
        slot = undefined;
        notify();
      }
    },
    retain(key: object, value: unknown) {
      if (!live()) return false;
      const next = bodyBytes(value);
      let bytes = next;
      for (const [k, size] of sizes) if (k !== key) bytes += size;
      if (bytes > SOCIAL_LIMITS.bodyBytes) return false;
      sizes.set(key, next);
      return true;
    },
    drop(key: object) {
      sizes.delete(key);
    },
    remember(ref: DirectConversationRef) {
      if (!live()) return false;
      const key = conversationKey(ref);
      if (!refs.has(key) && refs.size >= 58) return false;
      refs.set(key, freezeSocial({ ...ref }));
      return true;
    },
    knows(ref: DirectConversationRef) {
      return live() && refs.has(conversationKey(ref));
    },
    forget(ref: DirectConversationRef) {
      refs.delete(conversationKey(ref));
    },
    onEnd(purge: () => void, notify: () => void) {
      const callbacks = { purge, notify };
      if (!live()) {
        purge();
        notify();
      } else ends.add(callbacks);
      return () => ends.delete(callbacks);
    },
    subscribe(callback: () => void) {
      if (!live()) return () => undefined;
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
  };
}
export function socialOwnerFor(scope: AccountScope) {
  let owner = owners.get(scope);
  if (!owner) {
    owner = makeOwner(scope);
    owners.set(scope, owner);
  }
  if (!owner.live()) throw new ScopeEndedError();
  return owner;
}
