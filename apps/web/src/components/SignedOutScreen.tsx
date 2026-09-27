import { useState } from 'react';
import type { ApiClient } from '../api/client.ts';

export interface SignedOutScreenProps {
  /** Only the one route this screen needs -- never the whole client, so a test (or a future
   * caller) can pass a bare fake without also faking every other method `ApiClient` carries. */
  apiClient: Pick<ApiClient, 'postMagicLink'>;
  /** An optional, real reason shown above the form -- e.g. "Your account and history were
   * deleted." after a real ADR-0035 deletion, or nothing at all for an ordinary 401/sign-out.
   * Never fabricated: the caller only ever passes a message that came from an actual event. */
  message?: string | null;
}

type RequestState = { status: 'idle' } | { status: 'sending' } | { status: 'sent' } | { status: 'error'; message: string };

/**
 * The screen the app shows whenever the API answers 401 for the universe/session (no cookie,
 * revoked, deleted) -- also reused, with an explanatory `message`, right after a real sign-out or
 * account deletion (#135). ADR-0026's own rule governs the one control here: `POST
 * /v1/auth/magic-link` always answers the same 202 whether or not the typed address has an
 * account, so this screen shows the identical fixed confirmation either way -- never a hint that
 * would let a caller learn whether an address is registered.
 */
export function SignedOutScreen({ apiClient, message = null }: SignedOutScreenProps) {
  const [email, setEmail] = useState('');
  const [request, setRequest] = useState<RequestState>({ status: 'idle' });
  const sending = request.status === 'sending';

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (sending) return;
    setRequest({ status: 'sending' });
    apiClient
      .postMagicLink(email)
      .then(() => setRequest({ status: 'sent' }))
      .catch(() => setRequest({ status: 'error', message: 'Connection interrupted. Please retry.' }));
  };

  return (
    <main className="rest-screen" aria-label="Sign in">
      <div className="rest-card">
        <p className="eyebrow">KnowScroll</p>
        <h2>Sign in</h2>
        {message && (
          <p role="status" aria-live="polite">
            {message}
          </p>
        )}
        {request.status === 'sent' ? (
          <p role="status" aria-live="polite">
            Check your email for a sign-in link
          </p>
        ) : (
          <form onSubmit={onSubmit}>
            <label className="privacy-confirm-label" htmlFor="signed-out-email">
              Email
            </label>
            <input
              id="signed-out-email"
              className="privacy-confirm-input"
              type="email"
              required
              value={email}
              onChange={event => setEmail(event.target.value)}
              disabled={sending}
              autoComplete="email"
            />
            {request.status === 'error' && (
              <p className="privacy-error" role="alert">
                {request.message}
              </p>
            )}
            <div className="rest-actions">
              <button type="submit" className="pill teal" disabled={sending} aria-label="Send sign-in link">
                {sending ? 'Sending…' : 'Send sign-in link'}
              </button>
            </div>
          </form>
        )}
      </div>
    </main>
  );
}
