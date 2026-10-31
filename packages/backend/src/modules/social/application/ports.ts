import type { Invite } from '../domain/invites.js';
import type { PublicPersonRef } from '@knowscroll/contracts';
import type {
  PersonalScopeTx,
  SharedScopeTx,
  WithPersonalScope,
  FenceAccountPair,
  FenceOwnAccount,
} from '../../identity/public.js';
import type { Pair, Operation } from '../domain/friends.js';
import type { PresencePreference, PresenceRecord } from '../domain/presence.js';
import type { VisibilityStore } from './visibility-store.js';
export type SocialRefusal =
  'invalid_input' | 'unavailable' | 'stale_revision' | 'command_key_reused' | 'unsupported' | 'counter_exhausted';
export type Result<T> =
  { readonly kind: 'ok'; readonly value: T } | { readonly kind: 'refused'; readonly code: SocialRefusal };
export interface Profile {
  accountId: string;
  person: PublicPersonRef;
  revision: number;
}
/** A locked shared root: the friendship (`PairLock`) or a content thread. */
export interface SharedLock {
  shared: SharedScopeTx;
}
export interface PairLock extends SharedLock {
  pair: Pair;
}
export interface Binding {
  epoch: number;
  lineage: string | null;
}
export interface ReceiptKey {
  commandId: string;
  operation: string;
  requestHash: string;
  outcomeVersion: number;
}
export interface SocialStore {
  profile(
    scope: PersonalScopeTx,
    by: { accountId: string } | { personId: string } | { handle: string },
  ): Promise<Profile | undefined>;
  saveProfile(scope: PersonalScopeTx, profile: Profile): Promise<void>;
  lockPair(scope: PersonalScopeTx, actor: string, peer: string, create: boolean): Promise<PairLock | undefined>;
  savePair(lock: PairLock, pair: Pair): Promise<void>;
  /**
   * A friendship began or ended: whoever one of the two had invited into a thread loses their place there
   * (their membership no longer stands), and their party place and their picks on its calls go with it (D-065, D-156).
   */
  forgetPartyBetween(lock: PairLock, accountA: string, accountB: string): Promise<void>;
  binding(lock: PairLock, actor: string, operation: Operation, command: string): Promise<Binding | undefined>;
  bind(lock: PairLock, actor: string, operation: Operation, command: string, binding: Binding): Promise<void>;
  findReceipt(
    scope: PersonalScopeTx | SharedLock,
    key: ReceiptKey,
  ): Promise<{ kind: 'new' } | { kind: 'replay'; outcome: unknown } | { kind: 'refused'; code: SocialRefusal }>;
  beginReceipt(scope: PersonalScopeTx | SharedLock, key: ReceiptKey): Promise<void>;
  receipt(scope: PersonalScopeTx | SharedLock, key: ReceiptKey, outcome: object): Promise<void>;
}
export type RosterKind = 'friends' | 'incoming' | 'outgoing' | 'blocked';
export interface RosterCertificate {
  accountId: string;
  universeId: string;
  epoch: number;
  filter: RosterKind;
  revision: number;
  limit: number;
  after: string;
  started: number;
  until: number;
}
export interface RosterCursorCodec {
  encode(c: RosterCertificate): string;
  decode(token: string): RosterCertificate | undefined;
}
export interface RosterCandidate {
  person: PublicPersonRef;
  revision: number;
  requestId: string | null;
  expiresAt: string | null;
  eligible: boolean;
  /** What the peer chose to show and their last heartbeat; only a friends page turns it into a word. */
  presence: { preference: PresencePreference; record: PresenceRecord | undefined };
}
export interface RosterStore {
  head(scope: PersonalScopeTx, filter: RosterKind): Promise<number>;
  scan(
    scope: PersonalScopeTx,
    filter: RosterKind,
    after: string | undefined,
    limit: number,
  ): Promise<RosterCandidate[]>;
  deadline(scope: PersonalScopeTx, filter: RosterKind, now: Date): Promise<Date | undefined>;
}
export interface InviteStore {
  read(scope: PersonalScopeTx, by: { accountId: string } | { tokenHash: string }): Promise<Invite | undefined>;
  save(scope: PersonalScopeTx, value: Invite): Promise<void>;
}
export interface SocialPorts {
  withScope: WithPersonalScope;
  fencePair: FenceAccountPair;
  fenceOwn: FenceOwnAccount;
  store: SocialStore;
  newId(): string;
  hash(operation: string, input: unknown): string;
  now(): Date;
  invites: InviteStore;
  rosters: RosterStore;
  cursor: RosterCursorCodec;
  secret(): string;
  digest(secret: string): string;
  visibility: VisibilityStore;
}
export const refuse = (code: SocialRefusal): Result<never> => ({ kind: 'refused', code });
/** The scope every conversation and share answer names: the caller's account and epoch. */
export const conversationEnvelope = (scope: PersonalScopeTx) => {
  if (scope.authority.actor.kind !== 'account') throw new Error('SOCIAL_ACCOUNT_REQUIRED');
  return {
    version: 'direct-conversation.v1' as const,
    scope: { accountId: scope.authority.actor.accountId, privacyEpoch: scope.authority.privacyEpoch },
  };
};
/** The scope every content-thread answer names: the caller's account and epoch. */
export const threadEnvelope = (scope: PersonalScopeTx) => {
  if (scope.authority.actor.kind !== 'account') throw new Error('SOCIAL_ACCOUNT_REQUIRED');
  return {
    version: 'content-thread.v1' as const,
    scope: { accountId: scope.authority.actor.accountId, privacyEpoch: scope.authority.privacyEpoch },
  };
};
export const ownEnvelope = (scope: PersonalScopeTx) => {
  if (scope.authority.actor.kind !== 'account') throw new Error('SOCIAL_ACCOUNT_REQUIRED');
  return {
    version: 'sharing.v1' as const,
    scope: { accountId: scope.authority.actor.accountId, privacyEpoch: scope.authority.privacyEpoch },
  };
};
