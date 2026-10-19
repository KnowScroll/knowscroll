import { memoryStore, type KeyValueStore } from '@knowscroll/client-core';

/**
 * Web: the account scope's local storage over `localStorage` (keys `ks.scope.<account>:<epoch>.…`,
 * purged when the scope ends). Falls back to memory where storage is unavailable (private
 * browsing, blocked storage).
 */
function browserStore(): KeyValueStore {
  try {
    const storage = window.localStorage;
    const probe = 'ks.scope.probe';
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return {
      keys: () =>
        Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter((key) => key !== null),
      getItem: (key) => storage.getItem(key),
      setItem: (key, value) => storage.setItem(key, value),
      removeItem: (key) => storage.removeItem(key),
    };
  } catch {
    return memoryStore();
  }
}

export const scopeStorage: KeyValueStore = browserStore();
