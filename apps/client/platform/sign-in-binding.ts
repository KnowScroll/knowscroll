import { CryptoDigestAlgorithm, CryptoEncoding, digestStringAsync, getRandomBytes } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { base64UrlOfBase64, base64UrlOfBytes, type SignInBinding } from '@knowscroll/client-core';

const key = 'ks.signin.verifier';
const options = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

/**
 * Native (review m10): sign-in links are bound to this device. A random 32-byte verifier is kept
 * in the platform secure store (as the session token is) and reused until a link is redeemed, so
 * every link asked for meanwhile works; the link is asked for with its S256 challenge, and only a
 * redemption that presents the verifier signs in. A link intercepted on its way to the app opens
 * nothing on another device. Not proved on a device yet: native builds are not set up.
 */
export const signInBinding: SignInBinding | undefined = {
  async challenge() {
    let verifier = await SecureStore.getItemAsync(key, options);
    if (verifier === null) {
      verifier = base64UrlOfBytes(getRandomBytes(32));
      await SecureStore.setItemAsync(key, verifier, options);
    }
    const digest = await digestStringAsync(CryptoDigestAlgorithm.SHA256, verifier, {
      encoding: CryptoEncoding.BASE64,
    });
    return base64UrlOfBase64(digest);
  },
  async verifier() {
    return (await SecureStore.getItemAsync(key, options)) ?? undefined;
  },
  async clear() {
    await SecureStore.deleteItemAsync(key, options);
  },
};
