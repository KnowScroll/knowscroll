/** Who may join a room, who may act in it, and what a moderator may do. No database, clock or crypto. */

export type JoinRule = 'open' | 'friends_of_members' | 'invite_only';
export type RoomStatus = 'open' | 'paused' | 'closed';
export type RoomRole = 'member' | 'moderator';

/** Why a person cannot join. `removed` and `closed` are final for the person; the others have a way forward. */
export type JoinBlock = 'invite_only' | 'friend_of_member_needed' | 'profile_needed' | 'paused' | 'closed' | 'removed';

/** What the caller's earlier place in the room was, if any. */
export type EarlierPlace = 'never' | 'left' | 'removed';

export interface JoinFacts {
  readonly rule: JoinRule;
  readonly status: RoomStatus;
  readonly earlier: EarlierPlace;
  /** The caller has a claimed sharing profile: members show by name, so a room needs one. */
  readonly hasProfile: boolean;
  /** A current member invited the caller and is still a member. */
  readonly invited: boolean;
  /** The caller is a current friend of at least one current member. */
  readonly friendOfMember: boolean;
}

export type JoinDecision = { readonly allowed: true } | { readonly allowed: false; readonly reason: JoinBlock };

/**
 * Whether a person who is not a member may join now. A removed person stays out, a closed or paused
 * room takes nobody, and an invitation opens the door of a room whose rule is not `open`. The profile
 * is asked last so the answer names the way in first.
 */
export function joinDecision(facts: JoinFacts): JoinDecision {
  if (facts.earlier === 'removed') return { allowed: false, reason: 'removed' };
  if (facts.status === 'closed') return { allowed: false, reason: 'closed' };
  if (facts.status === 'paused') return { allowed: false, reason: 'paused' };
  const welcome =
    facts.rule === 'open' || facts.invited || (facts.rule === 'friends_of_members' && facts.friendOfMember);
  if (!welcome)
    return { allowed: false, reason: facts.rule === 'invite_only' ? 'invite_only' : 'friend_of_member_needed' };
  return facts.hasProfile ? { allowed: true } : { allowed: false, reason: 'profile_needed' };
}

/** Messages and new discussions: only while the room is open. A paused or closed room can still be read. */
export const roomAcceptsPosts = (status: RoomStatus): boolean => status === 'open';

export const isModerator = (role: RoomRole): boolean => role === 'moderator';

/**
 * Pause and resume move between `open` and `paused`; a closed room is closed by the operator and
 * moderators cannot reopen it. `undefined` means the action does nothing in this status.
 */
export function statusAfter(action: 'pause' | 'resume', status: RoomStatus): RoomStatus | undefined {
  if (action === 'pause') return status === 'open' ? 'paused' : undefined;
  return status === 'paused' ? 'open' : undefined;
}

/** A moderator removes ordinary members only: not themselves (they can leave) and not each other. */
export function canRemove(
  actor: { readonly accountId: string },
  target: { readonly accountId: string; readonly role: RoomRole },
): boolean {
  return target.role === 'member' && target.accountId !== actor.accountId;
}

/** How much the room's AI inhabitants may speak to one member (R3 question 5). */
export type AiLevel = 'lively' | 'quieter' | 'off';

/**
 * The level a new member starts at: Lively in a room anyone can enter, Quieter in a room that is closed to
 * strangers. Their own choice replaces it and a person who comes back keeps what they chose.
 */
export const defaultAiLevel = (rule: JoinRule): AiLevel => (rule === 'open' ? 'lively' : 'quieter');

/** The words that stand in for a member's message when they keep their messages out of what AI reads. */
export const KEPT_OUT_MESSAGE = "[a member's message]";
