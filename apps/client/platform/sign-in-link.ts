import * as Linking from 'expo-linking';
import { useMemo } from 'react';
import { tokenFromLink } from './sign-in-link-token';

export { tokenFromLink };

/**
 * Native: the token of the link that opened the app (an app or universal link to `/redeem`). Not proved yet: native builds and app links are not set up (owner decision 2).
 */
export function useSignInLinkToken(): string | undefined {
  const url = Linking.useLinkingURL();
  return useMemo(() => (url === null ? undefined : tokenFromLink(url)), [url]);
}
