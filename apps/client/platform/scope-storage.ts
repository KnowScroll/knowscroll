import { memoryStore, type KeyValueStore } from '@knowscroll/client-core';

/**
 * Native: the account scope's local storage. Nothing scoped is persisted on native yet, so it
 * lives in memory and ends with the app; a persistent store replaces this when a feature needs
 * one, behind the same interface and the same purge.
 */
export const scopeStorage: KeyValueStore = memoryStore();
