import { parseAddress } from '../domain/addresses.js';
import { LINK_LIMITS } from '../domain/policy.js';
import type { RequestSignIn, RequestSignInResult, SignInBudget } from '../public.js';
import type { BudgetCheck, MailDelivery, RequestSignInPorts } from './ports.js';

const budgets: readonly BudgetCheck[] = [
  { budget: 'address', limit: LINK_LIMITS.address },
  { budget: 'domain', limit: LINK_LIMITS.domain },
  { budget: 'world', limit: LINK_LIMITS.world },
];

/**
 * `requestSignIn`: mail a single-use sign-in link to an address (POST /auth/sign-in).
 *
 * Authority: none; anyone may ask for a link for any address. The answer is the same whether or
 *   not an account exists, and no account is created here: the account is created when a link is
 *   redeemed (no accounts for addresses nobody confirmed).
 * Steps: refuse a native code challenge unless native sign-in binding is on (re-review N1) →
 *   accept the address (strict RFC 5321 subset, `domain/addresses.ts`) → one short transaction
 *   under the address lock: the address, recipient-domain and world-wide budgets in that order
 *   (each but the address one under its own advisory lock), each counting only links already issued, so malformed or refused requests spend
 *   none of them (review M2); the first full budget refuses (Retry-After) and writes nothing;
 *   otherwise store the new link's hash with a 15-minute expiry (database clock) → after commit,
 *   start the one mail delivery and log its outcome once. A domain or world budget that fills is
 *   logged once per window (`identity.sign_in_budget_full`) for alerting.
 * Side effects: one `identity.sign_in_links` row; one outgoing mail attempt, outside every
 *   transaction (the AgentMail adapter refuses to run inside one). Old links are removed by the
 *   scheduled sweep, never here.
 * Failure/retry: a delivery failure is logged and otherwise invisible; the person asks again
 *   (each request is a new link; there is no silent resend). A database failure answers as usual
 *   (retryable 503 for lock waits) and sends nothing.
 */
export function makeRequestSignIn(ports: RequestSignInPorts): RequestSignIn {
  const alerted = new Map<SignInBudget, number>();

  /** One record per budget per window, so a flood raises one alert, not thousands of lines. */
  function alertOnce(budget: SignInBudget): void {
    if (budget === 'address') return;
    const now = ports.now();
    const last = alerted.get(budget);
    if (last !== undefined && now - last < LINK_LIMITS[budget].windowSeconds * 1000) return;
    alerted.set(budget, now);
    ports.logEvent('identity.sign_in_budget_full', { reasonCode: budget });
  }

  return async function requestSignIn(input): Promise<RequestSignInResult> {
    // Re-review N1: until the native app ships, a challenge is refused, so nobody can bind a
    // person's links to a verifier only they hold and lock the address out of its own budget.
    if (input.codeChallenge !== undefined && !ports.nativeBinding) {
      ports.logEvent('identity.sign_in_requested', { outcome: 'binding_not_enabled' });
      return { kind: 'refused', reason: 'binding_not_enabled' };
    }
    const address = parseAddress(input.email);
    if (address === undefined) {
      ports.logEvent('identity.sign_in_requested', { outcome: 'invalid_address' });
      return { kind: 'refused', reason: 'invalid_address' };
    }
    const secret = ports.secrets.newLinkSecret();
    const created = await ports.createEmailLink({
      address: address.address,
      domain: address.domain,
      tokenHash: secret.hash,
      codeChallenge: input.codeChallenge,
      budgets,
    });
    if (created.kind === 'rate_limited') {
      ports.logEvent('identity.sign_in_requested', { outcome: `${created.budget}_rate_limited` });
      alertOnce(created.budget);
      return created;
    }
    ports.logEvent('identity.sign_in_requested', { outcome: 'accepted' });
    const startedAt = ports.now();
    const delivery = ports
      .sendMail({ to: address.address, link: ports.linkFor(secret.token) })
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
