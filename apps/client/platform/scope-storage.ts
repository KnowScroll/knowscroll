import { memoryStore, type KeyValueStore } from '@knowscroll/client-core';
import { createNativeScopeDurability } from './native-scope-durability';

/** Only used before an authenticated scope exists; native scopes use prepared encrypted stores. */
export const scopeStorage: KeyValueStore = memoryStore();
export const scopeDurability = createNativeScopeDurability();
