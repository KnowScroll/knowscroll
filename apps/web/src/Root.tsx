import { useCallback, useMemo, useState } from 'react';
import { App } from './App.tsx';
import { ApiClient } from './api/client.ts';
import { SignedOutScreen } from './components/SignedOutScreen.tsx';
import { SignInPage } from './components/SignInPage.tsx';

type AuthState = { screen: 'reader' } | { screen: 'signed-out'; message: string | null };

/**
 * #135: the one place a bare `new ApiClient()` is built, and the one place that decides between
 * the real reader app, the desktop sign-in page (`/sign-in#token=...`, ADR-0034 section 6), and
 * the signed-out screen. Everything downstream shares this single `ApiClient` instance so the
 * in-memory CSRF token a sign-in mints (or a lazy 403 later discovers -- see client.ts) survives
 * every later reader action without a reload; a fresh instance only ever appears when the page
 * itself actually reloads, which is also the only time this in-memory token is allowed to be lost.
 *
 * `App` never sees a signed-out state of its own -- the moment `ReaderStore`'s `onSignedOut`
 * fires (a 401, a real sign-out, a real account deletion, or a Reset that may have completed), this component swaps the whole
 * reader tree for `SignedOutScreen` rather than leaving `App` to render some dead-end state.
 *
 * The one exception is an *ambient* 401 (`verify === true`, see `ReaderStore`'s own doc comment)
 * in a bearer/dev-proxy deployment: that shape has no sign-in surface of its own, so this screen
 * would be a dead end where the app's existing fail-closed-Unavailable-and-retry already recovers
 * (ADR-0022). `ApiClient.isBearerSession()` confirms that before swapping -- never merely assumed,
 * since guessing wrong the other way would silently strand a real cookie-deployment reader.
 */
export function Root() {
  const apiClient = useMemo(() => new ApiClient(), []);
  const [auth, setAuth] = useState<AuthState>({ screen: 'reader' });

  const showSignedOut = useCallback(
    (message: string | null) => {
      // A dead session can never authenticate a change again; forgetting the token here (rather
      // than leaving a stale one cached) matches ApiClient's own "never persisted" CSRF contract.
      apiClient.setCsrfToken(null);
      setAuth({ screen: 'signed-out', message });
    },
    [apiClient],
  );

  const onSignedOut = useCallback(
    (message: string | null, verify: boolean) => {
      if (!verify) {
        showSignedOut(message);
        return;
      }
      apiClient.isBearerSession().then(isBearer => {
        if (!isBearer) showSignedOut(message);
        // A confirmed bearer/dev-proxy session: leave ReaderStore's own fail-closed Unavailable
        // state exactly as it already rendered -- its own "Retry loading the universe" is the
        // real recovery this deployment shape has.
      });
    },
    [apiClient, showSignedOut],
  );

  const goToReader = useCallback(() => {
    window.history.pushState(null, '', '/');
    setAuth({ screen: 'reader' });
  }, []);

  const goToSignedOut = useCallback(() => {
    window.history.pushState(null, '', '/');
    setAuth({ screen: 'signed-out', message: null });
  }, []);

  if (window.location.pathname === '/sign-in') {
    return <SignInPage apiClient={apiClient} onSignedIn={goToReader} onRequestNewLink={goToSignedOut} />;
  }

  if (auth.screen === 'signed-out') {
    return <SignedOutScreen apiClient={apiClient} message={auth.message} />;
  }

  return <App apiClient={apiClient} onSignedOut={onSignedOut} />;
}
