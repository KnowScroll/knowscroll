import type { PersonalScopeTx, SharedScopeTx } from '../../identity/public.js';
import type { PresencePreference, PresenceRecord } from '../domain/presence.js';
import type { PublishedSystem } from '../domain/visibility.js';

/** Who a person lets visit, as stored: the mode, plus the two settings' own counters. */
export type AudienceMode = 'nobody' | 'chosen_friends' | 'all_friends';
export interface StoredVisibility {
  readonly audience: AudienceMode;
  readonly visibilityRevision: number;
  readonly presencePreference: PresencePreference;
  readonly presenceRevision: number;
}

/** A person who never changed a setting: nobody may visit and availability is hidden (D-006 e). */
export const DEFAULT_VISIBILITY: StoredVisibility = {
  audience: 'nobody',
  visibilityRevision: 1,
  presencePreference: 'hidden',
  presenceRevision: 1,
};

/** What visitors are shown of one universe, as of the last refresh. */
export interface StoredPublication {
  /** Random; changes only when the list a visitor receives changes. Counts nothing. */
  readonly projectionToken: number;
  readonly geographyRevision: number;
  readonly systems: readonly PublishedSystem[];
}

/** A friend an owner chose, by both of the identities the module uses. */
export interface ChosenFriend {
  readonly accountId: string;
  readonly personId: string;
}

/** A transaction that may read these rows: the person's own scope, or a friendship lock taken after it. */
export type VisibilityTx = PersonalScopeTx | SharedScopeTx;

/**
 * Rows of visibility settings, the visitor audience, availability and the published copy of a
 * universe (D-047). Methods take the capability of an open locked scope and run plain queries; the
 * use cases decide who may call them. Reads never write.
 */
export interface VisibilityStore {
  /** The two settings of an account; the defaults while it never changed one. */
  settings(tx: VisibilityTx, accountId: string): Promise<StoredVisibility>;
  saveSettings(scope: PersonalScopeTx, accountId: string, settings: StoredVisibility): Promise<void>;

  /** The friends an owner chose, with the public identity each is known by. */
  chosenFriends(tx: VisibilityTx, ownerAccountId: string): Promise<readonly ChosenFriend[]>;
  /** Of these people, those who are the owner's friends right now. */
  currentFriends(
    scope: PersonalScopeTx,
    ownerAccountId: string,
    personIds: readonly string[],
  ): Promise<readonly ChosenFriend[]>;
  replaceChosenFriends(
    scope: PersonalScopeTx,
    ownerAccountId: string,
    friendAccountIds: readonly string[],
  ): Promise<void>;
  /** A friendship began or ended: neither person's choice of the other survives it. */
  forgetChoiceBetween(lock: SharedScopeTx, accountA: string, accountB: string): Promise<void>;

  /** The last heartbeat of an account, if it shows availability and sent one. */
  presence(tx: VisibilityTx, accountId: string): Promise<PresenceRecord | undefined>;
  /** Hiding availability stores nothing: the old heartbeat goes. */
  clearPresence(scope: PersonalScopeTx, accountId: string): Promise<void>;

  publication(tx: VisibilityTx, universeId: string): Promise<StoredPublication | undefined>;
  /** Replaces the published copy so it equals `next`, keeping the rows (and public identities) that stay. */
  savePublication(
    scope: PersonalScopeTx,
    universeId: string,
    next: StoredPublication & { readonly refreshedAt: Date },
  ): Promise<void>;
}
