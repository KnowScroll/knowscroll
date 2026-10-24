import * as SecureStore from 'expo-secure-store';
import type { KeyValueStore } from '@knowscroll/client-core';
import { createSecureKeyValueStore, type SecureItemBackend } from './secure-key-value-store';

const options = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

/** The platform secure store (Keychain on iOS, Keystore-backed storage on Android) as the backend. */
const platformBackend: SecureItemBackend = {
  getItem: (name) => SecureStore.getItem(name, options),
  setItem: (name, value) => SecureStore.setItemAsync(name, value, options),
  deleteItem: (name) => SecureStore.deleteItemAsync(name, options),
};

/**
 * Native: the account scope's local storage, kept in the platform's encrypted storage so the
 * camera, Keep places, the observation outbox and the deletion receipt id survive an app restart.
 * The scope manager purges it when a scope ends and removes what an earlier run left behind
 * (`createSecureKeyValueStore` has the write and failure rules).
 */
export const scopeStorage: KeyValueStore = createSecureKeyValueStore(platformBackend);
