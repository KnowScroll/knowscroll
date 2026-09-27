import { useEffect, useRef, useState } from 'react';
import { ApiException, type ApiClient } from '../api/client.ts';

export interface SignInPageProps {
  apiClient: Pick<ApiClient, 'postWebSession' | 'setCsrfToken'>;
  /** The reader is authenticated -- go show the app. */
  onSignedIn: () => void;
  /** The link is unusable (expired, already used, or missing) -- go back to the signed-out screen. */
  onRequestNewLink: () => void;
}

type ConsumeState =
  | { status: 'no-token' }
  | { status: 'ready'; token: string }
  | { status: 'consuming'; token: string }
  | { status: 'expired' }
  | { status: 'error'; token: string; message: string };

function extractToken(): string | null {
  const hash = window.location.hash;
  if (!hash || hash.length < 2) return null;
  return new URLSearchParams(hash.slice(1)).get('token');
}

/**
 * `/sign-in` (ADR-0034 section 6): the emailed link's own page. The token travels only in the URL
 * fragment (never a query string, so it never reaches a server log or a `Referer`), and this page
 * strips that fragment with `history.replaceState` the instant it mounts -- before the reader has
 * done anything -- so a mail scanner that merely loads the page, or a reload, never leaves the
 * token sitting in the address bar or browser history. The token itself lives only in this
 * component's state from that point on: nothing is posted to the server until the reader presses
 * "Sign in on this browser".
 *
 * The strip-and-extract runs behind a `useRef` guard (not a bare effect or a `useState` lazy
 * initializer) specifically so it happens exactly once even under React StrictMode's development
 * double-invocation, which would otherwise read the fragment a second time *after* the first pass
 * already removed it.
 */
export function SignInPage({ apiClient, onSignedIn, onRequestNewLink }: SignInPageProps) {
  const consumedRef = useRef(false);
  const [state, setState] = useState<ConsumeState>({ status: 'no-token' });

  useEffect(() => {
    if (consumedRef.current) return;
    consumedRef.current = true;
    const token = extractToken();
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    setState(token ? { status: 'ready', token } : { status: 'no-token' });
  }, []);

  const consume = (token: string) => {
    setState({ status: 'consuming', token });
    apiClient
      .postWebSession(token)
      .then(response => {
        // Never persisted; ApiClient itself only ever keeps this in memory (see client.ts).
        apiClient.setCsrfToken(response.csrfToken);
        onSignedIn();
      })
      .catch((error: unknown) => {
        if (error instanceof ApiException && error.error.kind === 'server' && error.error.statusCode === 401) {
          setState({ status: 'expired' });
        } else {
          setState({ status: 'error', token, message: 'Connection interrupted. Please retry.' });
        }
      });
  };

  return (
    <main className="rest-screen" aria-label="Sign in">
      <div className="rest-card">
        <p className="eyebrow">KnowScroll</p>
        {(state.status === 'ready' || state.status === 'consuming') && (
          <>
            <h2>Sign in on this browser</h2>
            <p>Continue on this device with the link you opened.</p>
            {state.status === 'consuming' ? (
              <p role="status" aria-live="polite">
                Signing in…
              </p>
            ) : (
              <div className="rest-actions">
                <button type="button" className="pill teal" onClick={() => consume(state.token)} aria-label="Sign in on this browser">
                  Sign in on this browser
                </button>
              </div>
            )}
          </>
        )}
        {(state.status === 'expired' || state.status === 'no-token') && (
          <>
            <h2>This link has expired or was already used.</h2>
            <div className="rest-actions">
              <button type="button" className="pill teal" onClick={onRequestNewLink} aria-label="Request a new link">
                Request a new link
              </button>
            </div>
          </>
        )}
        {state.status === 'error' && (
          <>
            <p className="privacy-error" role="alert">
              {state.message}
            </p>
            <div className="rest-actions">
              <button type="button" className="pill teal" onClick={() => consume(state.token)} aria-label="Try again">
                Try again
              </button>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
