import * as SecureStore from 'expo-secure-store';
import type { SessionTokenStore } from '@knowscroll/client-core';

const key = 'ks.session';

/**
 * Native: the bearer session token lives in the platform secure store (Keychain on iOS,
 * Keystore-backed storage on Android), readable only after the device was first unlocked, and
 * never in plain storage, logs or the URL (D-007, D-018).
 */
export const sessionTokens: SessionTokenStore | undefined = {
  async read() {
    return (await SecureStore.getItemAsync(key)) ?? undefined;
  },
  async write(token) {
    await SecureStore.setItemAsync(key, token, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY });
  },
  async clear() {
    await SecureStore.deleteItemAsync(key);
  },
};
