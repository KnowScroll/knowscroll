import type { ApiClient } from './api-client';

export type FriendsOperation =
  | 'profile'
  | 'setProfile'
  | 'lookup'
  | 'pair'
  | 'friends'
  | 'requests'
  | 'request'
  | 'accept'
  | 'decline'
  | 'cancel'
  | 'remove'
  | 'block'
  | 'unblock'
  | 'invites'
  | 'createInvite'
  | 'revokeInvite'
  | 'resolveInvite';
export type FriendsCommandOperation =
  | 'setProfile'
  | 'request'
  | 'accept'
  | 'decline'
  | 'cancel'
  | 'remove'
  | 'block'
  | 'unblock'
  | 'createInvite'
  | 'revokeInvite';
type FriendsApi = Pick<ApiClient['sharing'], Exclude<FriendsOperation, 'friends' | 'requests'>> &
  Pick<ApiClient['friendPages'], 'friends' | 'requests'>;
export type FriendsInput<K extends FriendsOperation> = Parameters<FriendsApi[K]>[0];
export type FriendsOutput<K extends FriendsOperation> = Awaited<ReturnType<FriendsApi[K]>>;
export type FriendsCommandDraft<K extends FriendsCommandOperation> = Omit<FriendsInput<K>, 'version' | 'commandId'>;
export type FriendsFilter = FriendsInput<'friends'>['filter'] | FriendsInput<'requests'>['filter'];
export type FriendsPage = FriendsOutput<'friends'> | FriendsOutput<'requests'>;
export type FriendsCursor = NonNullable<FriendsInput<'friends'>['cursor']>;
export type FriendsFailure = 'network' | 'invalid' | 'authority' | 'unavailable' | 'refresh_required' | 'conflict';
export type FriendsReadState<T> =
  | { readonly status: 'idle' | 'loading' }
  | { readonly status: 'ready'; readonly data: T }
  | { readonly status: 'unavailable'; readonly reason: FriendsFailure };
export type FriendsAcceptance =
  | { [K in Exclude<FriendsCommandOperation, 'createInvite'>]: FriendsOutput<K> }[Exclude<
      FriendsCommandOperation,
      'createInvite'
    >]
  | FriendsOutput<'createInvite'>['acceptance'];
/** No command body or secret is exposed here. An ACK never supplies current relationship state. */
export type FriendsCommandState =
  | { readonly status: 'idle' }
  | { readonly status: 'pending' | 'unknown'; readonly operation: FriendsCommandOperation; readonly commandId: string }
  | {
      readonly status: 'accepted';
      readonly operation: FriendsCommandOperation;
      readonly acceptance: FriendsAcceptance;
      readonly delivery: 'available' | 'unavailable';
    }
  | { readonly status: 'rejected'; readonly operation: FriendsCommandOperation; readonly reason: FriendsFailure };
/** The lists that grow in place with Show more. */
export type ShowMoreFilter = Exclude<FriendsFilter, 'friends'>;
/** One relationship row, as the roster and the single-pair read both draw it. */
export type FriendsPair = FriendsPage['items'][number];
/**
 * The first page of each list, read together for the one Friends list. A list is absent until its
 * page was read, and every command clears them all: an acknowledgement never supplies the new state.
 */
export type FriendsGroups = { readonly [K in FriendsFilter]?: readonly FriendsPair[] };
export interface FriendsState {
  readonly status: 'active' | 'ended';
  readonly groups: FriendsGroups;
  /** The lists (not Friends, which pages with Next and Previous) whose first page was not all of them. */
  readonly moreOf: readonly ShowMoreFilter[];
  /** The read behind `showMore`: its page is added to the list, never shown on its own. */
  readonly more: FriendsReadState<FriendsPage>;
  readonly profile: FriendsReadState<FriendsOutput<'profile'>>;
  readonly lookup: FriendsReadState<FriendsOutput<'lookup'>>;
  readonly pair: FriendsReadState<FriendsOutput<'pair'>>;
  readonly invites: FriendsReadState<FriendsOutput<'invites'>>;
  readonly resolvedInvite: FriendsReadState<FriendsOutput<'resolveInvite'>>;
  readonly roster: FriendsReadState<FriendsPage>;
  readonly filter: FriendsFilter;
  /** Earlier retained cursor available, not a claim that a bounded history reaches the beginning. */
  readonly canPrevious: boolean;
  readonly canNext: boolean;
  readonly command: FriendsCommandState;
}
export interface FriendsSession {
  getState(): FriendsState;
  subscribe(listener: () => void): () => void;
  readProfile(): Promise<void>;
  lookup(handle: string): Promise<void>;
  readPair(peerPersonId: string): Promise<void>;
  readInvites(): Promise<void>;
  resolveInvite(token: string): Promise<void>;
  selectFilter(filter: FriendsFilter): Promise<void>;
  /**
   * Adds the next page of Waiting (Incoming, Sent) or Blocked to what `groups` holds. It never touches
   * Friends' own page or cursors, and does nothing when that list has no more.
   */
  showMore(filter: ShowMoreFilter): Promise<void>;
  /**
   * Reads the first page of Blocked, Sent, Incoming and Friends one after another (one read in
   * flight at a time), so one list can show all of them. Ends on Friends, whose paging stays live.
   */
  readGroups(): Promise<void>;
  refreshPage(): Promise<void>;
  nextPage(): Promise<void>;
  previousPage(): Promise<void>;
  /** Deliberate command only. Its revisions/reference must bind a current explicit read. */
  command<K extends FriendsCommandOperation>(operation: K, input: FriendsCommandDraft<K>): Promise<void>;
  /** Resends only the original body and ID. No automatic mutation retry exists. */
  retryCommand(): Promise<void>;
  /** Destructive ephemeral first delivery. Caller may deliberately copy a fragment link. */
  takeInviteToken(): string | undefined;
  dispose(): void;
}
