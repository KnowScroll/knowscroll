import * as SecureStore from 'expo-secure-store';

const ITEM = 'ks.device.preferences';

/**
 * Native: this device's display and playback choices, kept in the platform's own storage. The
 * value holds no account data and no credential, so it is not tied to a sign-in and is not purged
 * with an account scope.
 */
export const devicePreferencesStore = {
  read: (): string | null => {
    try {
      return SecureStore.getItem(ITEM);
    } catch {
      return null;
    }
  },
  write: (value: string): void => {
    void SecureStore.setItemAsync(ITEM, value).catch(() => undefined);
  },
};
