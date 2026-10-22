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
export type FriendsInput<K extends FriendsOperation> = Parameters<ApiClient['sharing'][K]>[0];
export type FriendsOutput<K extends FriendsOperation> = Awaited<ReturnType<ApiClient['sharing'][K]>>;
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
export interface FriendsState {
  readonly status: 'active' | 'ended';
  readonly profile: FriendsReadState<FriendsOutput<'profile'>>;
  readonly lookup: FriendsReadState<FriendsOutput<'lookup'>>;
  readonly pair: FriendsReadState<FriendsOutput<'pair'>>;
  readonly invites: FriendsReadState<FriendsOutput<'invites'>>;
  readonly resolvedInvite: FriendsReadState<FriendsOutput<'resolveInvite'>>;
  readonly roster: FriendsReadState<FriendsPage>;
  readonly filter: FriendsFilter;
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
