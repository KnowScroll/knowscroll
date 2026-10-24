/** Rules of content threads that need no database, clock or crypto. */

/** What a thread knows about one member's place in it. */
export interface MemberStanding {
  /** The member has not accepted the invitation yet. */
  readonly pending: boolean;
  /** The member declined or left. */
  readonly left: boolean;
  /**
   * Whether the ground the place stands on still holds: the member's account is active and, when a
   * friend's invitation carried them in, that friendship still stands (D-046).
   */
  readonly stands: boolean;
}

/** Reading the thread and sending into it: joined, not left, ground intact. */
export const canTakePart = (member: MemberStanding): boolean => !member.left && !member.pending && member.stands;

/** Seeing an invitation and answering it: invited, not answered, ground intact. */
export const canAnswerInvitation = (member: MemberStanding): boolean =>
  !member.left && member.pending && member.stands;

/** A friend can be invited when the caller's friendship with them stands and their account is active. */
export function invitable(friend: { readonly lineage: string | null; readonly accountActive: boolean }): boolean {
  return friend.lineage !== null && friend.accountActive;
}

/**
 * Who shows as a participant: people whose place stands (joined or invited). A member whose friendship
 * ended, who left or who declined is not listed, and nothing says why.
 */
export const isParticipant = (member: MemberStanding): boolean => !member.left && member.stands;
