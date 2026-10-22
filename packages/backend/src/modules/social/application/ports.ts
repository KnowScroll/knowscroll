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
export type SocialRefusal =
  'invalid_input' | 'unavailable' | 'stale_revision' | 'command_key_reused' | 'unsupported' | 'counter_exhausted';
export type Result<T> =
  { readonly kind: 'ok'; readonly value: T } | { readonly kind: 'refused'; readonly code: SocialRefusal };
export interface Profile {
  accountId: string;
  person: PublicPersonRef;
  revision: number;
}
export interface PairLock {
  shared: SharedScopeTx;
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
  binding(lock: PairLock, actor: string, operation: Operation, command: string): Promise<Binding | undefined>;
  bind(lock: PairLock, actor: string, operation: Operation, command: string, binding: Binding): Promise<void>;
  findReceipt(
    scope: PersonalScopeTx | PairLock,
    key: ReceiptKey,
  ): Promise<{ kind: 'new' } | { kind: 'replay'; outcome: unknown } | { kind: 'refused'; code: SocialRefusal }>;
  beginReceipt(scope: PersonalScopeTx | PairLock, key: ReceiptKey): Promise<void>;
  receipt(scope: PersonalScopeTx | PairLock, key: ReceiptKey, outcome: object): Promise<void>;
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
  ceiling: string;
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
}
export interface RosterStore {
  head(scope: PersonalScopeTx, filter: RosterKind): Promise<number>;
  ceiling(scope: PersonalScopeTx, filter: RosterKind): Promise<string | undefined>;
  scan(
    scope: PersonalScopeTx,
    filter: RosterKind,
    after: string | undefined,
    ceiling: string,
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
}
export const refuse = (code: SocialRefusal): Result<never> => ({ kind: 'refused', code });
export const ownEnvelope = (scope: PersonalScopeTx) => {
  if (scope.authority.actor.kind !== 'account') throw new Error('SOCIAL_ACCOUNT_REQUIRED');
  return {
    version: 'sharing.v1' as const,
    scope: { accountId: scope.authority.actor.accountId, privacyEpoch: scope.authority.privacyEpoch },
  };
};
