/** Versioned initial policy. Expiry is a pure server-time decision, never cleanup authority. */
export const INVITE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
export interface Invite {
  accountId: string;
  linkId: string;
  tokenHash: string;
  revision: number;
  createdAt: string;
  expiresAt: string;
  revoked: boolean;
}
export function inviteStatus(invite: Invite, now: number): 'active' | 'revoked' | 'expired' {
  return invite.revoked ? 'revoked' : now >= Date.parse(invite.expiresAt) ? 'expired' : 'active';
}
