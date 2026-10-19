import { normaliseAddress } from '../domain/addresses.js';
import { ADDRESS_LINK_LIMIT } from '../domain/policy.js';
import type { RequestSignIn, RequestSignInResult } from '../public.js';
import type { MailDelivery, RequestSignInPorts } from './ports.js';

/**
 * `requestSignIn`: mail a single-use sign-in link to an address (POST /auth/sign-in).
 *
 * Authority: none; anyone may ask for a link for any address. The answer is the same whether or
 *   not an account exists, and no account is created here: the account is created when a link is
 *   redeemed (no accounts for addresses nobody confirmed).
 * Steps: normalise the address → one short transaction under the address lock: refuse when the
 *   address already received `ADDRESS_LINK_LIMIT.max` links in the window, else store the new
 *   link's hash with a 15-minute expiry (database clock) and remove links that expired over a day
 *   ago → after commit, start the one mail delivery and log its outcome once.
 * Side effects: one `identity.sign_in_links` row; one outgoing mail attempt, outside every
 *   transaction (the AgentMail adapter refuses to run inside one).
 * Failure/retry: a delivery failure is logged and otherwise invisible; the person asks again
 *   (each request is a new link; there is no silent resend). A database failure answers as usual
 *   (retryable 503 for lock waits) and sends nothing.
 */
export function makeRequestSignIn(ports: RequestSignInPorts): RequestSignIn {
  return async function requestSignIn(input: { readonly email: string }): Promise<RequestSignInResult> {
    const address = normaliseAddress(input.email);
    if (address === undefined) {
      ports.logEvent('identity.sign_in_requested', { outcome: 'invalid_address' });
      return { kind: 'refused', reason: 'invalid_address' };
    }
    const secret = ports.secrets.newLinkSecret();
    const created = await ports.createEmailLink({ address, tokenHash: secret.hash, limit: ADDRESS_LINK_LIMIT });
    if (created.kind === 'rate_limited') {
      ports.logEvent('identity.sign_in_requested', { outcome: 'rate_limited' });
      return created;
    }
    ports.logEvent('identity.sign_in_requested', { outcome: 'accepted' });
    const startedAt = ports.now();
    const delivery = ports
      .sendMail({ to: address, link: ports.linkFor(secret.token) })
      .catch((): MailDelivery => ({ kind: 'failed', reason: 'network_error' }))
      .then((result) => {
        const durationMs = Math.max(0, ports.now() - startedAt);
        if (result.kind === 'sent')
          ports.logEvent('identity.sign_in_mail', { severity: 'info', outcome: 'sent', durationMs });
        else
          ports.logEvent('identity.sign_in_mail', {
            severity: 'warn',
            outcome: 'failed',
            reasonCode: result.reason,
            ...(result.status === undefined ? {} : { status: result.status }),
            durationMs,
          });
        return result;
      });
    return { kind: 'requested', delivery };
  };
}
