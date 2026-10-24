const KEY = 'ks.device.preferences';

/**
 * Web: this device's display and playback choices in `localStorage`. Where storage is blocked
 * (private browsing) the choice holds until the page closes and the app keeps its defaults after.
 */
export const devicePreferencesStore = {
  read: (): string | null => {
    try {
      return window.localStorage.getItem(KEY);
    } catch {
      return null;
    }
  },
  write: (value: string): void => {
    try {
      window.localStorage.setItem(KEY, value);
    } catch {
      // The choice still applies for this page's life.
    }
  },
};
