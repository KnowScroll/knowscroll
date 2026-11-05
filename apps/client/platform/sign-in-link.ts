import * as Linking from 'expo-linking';
import { useMemo } from 'react';
import { tokenFromLink } from './sign-in-link-token';

export { tokenFromLink };

/**
 * Native: read the token from the link Expo reports for `/redeem`; parsing alone never redeems it.
 * The app scheme is configured, but this hook does not establish universal-link or physical-device
 * acceptance. Redemption still needs the matching native verifier.
 */
export function useSignInLinkToken(): string | undefined {
  const url = Linking.useLinkingURL();
  return useMemo(() => (url === null ? undefined : tokenFromLink(url)), [url]);
}
