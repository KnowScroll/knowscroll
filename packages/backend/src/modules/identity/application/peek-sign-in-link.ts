import { maskAddress } from '../domain/addresses.js';
import type { PeekSignInLink } from '../public.js';
import type { PeekSignInPorts } from './ports.js';

/**
 * `peekSignInLink`: which account a link would sign into, without consuming it (POST /auth/peek,
 * review m8). The redeem page shows it as "Continue as …", so a person handed someone else's link
 * (login forgery by link, a session swap) sees whose account it opens before tapping. Read-only.
 *
 * - A web link (no code challenge) answers the **full** address (re-review N6): a mask such as
 *   `m•••@gmail.com` reads the same for a look-alike address, and the link's holder could redeem
 *   it and read the address anyway.
 * - A native link answers only to the app holding its verifier (an interceptor learns nothing),
 *   and then masked (`m•••@example.com`).
 * Unknown, expired and consumed links, links bound to the other kind of client, a native peek
 * without the right verifier, and operator links this world would refuse all answer
 * `link_invalid`, as redemption would.
 */
export function makePeekSignInLink(ports: PeekSignInPorts): PeekSignInLink {
  return async function peekSignInLink(request) {
    const link = await ports.readLink(ports.secrets.hashToken(request.token));
    if (link === undefined || link.expired || link.consumed !== undefined) return { kind: 'link_invalid' };
    if (link.origin === 'operator' && !ports.operatorAddressAllowed(link.address)) return { kind: 'link_invalid' };
    if (request.client === 'web')
      return link.codeChallenge === undefined ? { kind: 'usable', email: link.address } : { kind: 'link_invalid' };
    const bound =
      link.codeChallenge !== undefined &&
      request.codeVerifier !== undefined &&
      ports.secrets.challengeOf(request.codeVerifier) === link.codeChallenge;
    return bound ? { kind: 'usable', email: maskAddress(link.address) } : { kind: 'link_invalid' };
  };
}
