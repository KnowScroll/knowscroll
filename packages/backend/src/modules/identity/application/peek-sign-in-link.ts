import { maskAddress } from '../domain/addresses.js';
import type { PeekSignInLink } from '../public.js';
import type { PeekSignInPorts } from './ports.js';

/**
 * `peekSignInLink`: which account a link would sign into, masked (`m•••@example.com`), without
 * consuming it (POST /auth/peek, review m8). The redeem page shows it as "Continue as …", so a
 * person handed someone else's link (login forgery by link, a session swap) sees whose account it
 * opens before tapping. Read-only. Unknown, expired and consumed links, links bound to the other
 * kind of client (a native link has a code challenge, a web link none; review m10) and operator
 * links this world would refuse all answer `link_invalid`, as redemption would.
 */
export function makePeekSignInLink(ports: PeekSignInPorts): PeekSignInLink {
  return async function peekSignInLink(request) {
    const link = await ports.readLink(ports.secrets.hashToken(request.token));
    if (link === undefined || link.expired || link.consumed !== undefined) return { kind: 'link_invalid' };
    if ((link.codeChallenge !== undefined) !== (request.client === 'native')) return { kind: 'link_invalid' };
    if (link.origin === 'operator' && !ports.operatorAddressAllowed(link.address)) return { kind: 'link_invalid' };
    return { kind: 'usable', maskedEmail: maskAddress(link.address) };
  };
}
