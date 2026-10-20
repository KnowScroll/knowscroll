import { useState } from 'react';
import { tokenFromLink } from './sign-in-link-token';

export { tokenFromLink };

/**
 * Web: the token in this page's fragment (`/redeem#token=ksl_…`), read once and removed from the
 * address bar and history at once, so it does not linger in the URL, a bookmark or a screenshot.
 * The fragment never reached the server.
 */
export function useSignInLinkToken(): string | undefined {
  const [token] = useState<string | undefined>(() => {
    if (typeof window === 'undefined') return undefined;
    const found = tokenFromLink(window.location.hash);
    if (found !== undefined) window.history.replaceState(window.history.state, '', window.location.pathname);
    return found;
  });
  return token;
}
