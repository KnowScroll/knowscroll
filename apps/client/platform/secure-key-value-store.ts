import { base64UrlOfBytes, type KeyValueStore } from '@knowscroll/client-core';

/**
 * The platform's encrypted item store, as this module needs it. Reads are synchronous (the
 * account scope's storage is a synchronous port); writes and deletes are asynchronous.
 */
export interface SecureItemBackend {
  getItem(name: string): string | null;
  setItem(name: string, value: string): Promise<void>;
  deleteItem(name: string): Promise<void>;
}

export interface SecureStoreLimits {
  /** Most keys kept; the oldest written go first. */
  readonly maxEntries: number;
  /** Most characters of values kept in all; the oldest written go first. */
  readonly maxCharacters: number;
}

/** Sized for the scope's caches: the observation outbox (256 KiB) is the largest single value. */
export const DEFAULT_SECURE_STORE_LIMITS: SecureStoreLimits = { maxEntries: 256, maxCharacters: 1_048_576 };

/** Names this store gives to its own items; keys the callers choose never reach the backend as written. */
const ITEM_PREFIX = 'ks.kv.';
const INDEX_ITEM = 'ks.kv-index';

/** Secure stores accept only letters, digits, `.`, `-` and `_` in a name; caller keys hold `:` and more. */
function itemNameOf(key: string): string {
  return `${ITEM_PREFIX}${base64UrlOfBytes(new TextEncoder().encode(key))}`;
}

/**
 * A `KeyValueStore` kept in the platform's encrypted storage, for the native account scope
 * (blueprint §18). The values are small caches and recovery state (the camera, Keep places, the
 * observation outbox, the deletion receipt id), none of it a credential.
 *
 * - Memory is the working copy and serves every read once a key is known. A persisted key is read
 *   from the backend only the first time, so a restart finds what the last run wrote.
 * - A change reaches the backend a moment after the call, not at it; a process killed in between
 *   loses that change only. Changes are applied by one ordered queue that writes the final state
 *   of each key, so a purge can never be overtaken by an earlier write of the same key.
 * - The persisted index lists every key whose value may exist. A key joins the index before its
 *   value is written, and leaves it only after its value is deleted, so a kill in between leaves
 *   an index entry without a value, never a value nobody can find to purge.
 * - A backend that fails (a locked device, a lost key) loses persistence, not correctness, and
 *   never the index: after a failed index read or write the store stops writing values, keeps
 *   serving from memory, and tries to read the index again at its next read or change. It then
 *   merges what the earlier run persisted with what memory holds and catches the backend up.
 *   A purge made while the index could not be read cannot see the persisted keys; the next purge
 *   after the index is readable (a scope mount, a sign-out) removes them.
 * - It is bounded: past `limits`, the oldest written keys are evicted from memory and the
 *   backend. Callers treat the store as a cache that can miss.
 *
 * `flush()` resolves when every queued change has been tried (tests; never awaited by the app).
 */
export function createSecureKeyValueStore(
  backend: SecureItemBackend,
  limits: SecureStoreLimits = DEFAULT_SECURE_STORE_LIMITS,
): KeyValueStore & { flush(): Promise<void> } {
  /** Insertion order is write order: the first entry is the oldest. `undefined` = persisted, not loaded. */
  let entries = new Map<string, string | undefined>();
  let characters = 0;
  let queue: Promise<void> = Promise.resolve();
  /** False until the persisted index has been read (and again after a failed index write). */
  let indexReady = false;
  /** The index as last known to be persisted, so an unchanged key list is not written again. */
  let persistedIndex: string | undefined;
  /** Values set in memory that the backend may not hold yet (latest value per key). */
  const pendingValues = new Map<string, string>();
  /** Keys dropped from memory whose backend value may still exist. */
  const pendingRemovals = new Set<string>();

  function readIndex(): void {
    if (indexReady) return;
    let raw: string | null;
    try {
      raw = backend.getItem(INDEX_ITEM);
    } catch {
      return;
    }
    let persisted: unknown = [];
    try {
      persisted = JSON.parse(raw ?? '[]');
    } catch {
      // A corrupt index lists nothing.
    }
    const merged = new Map<string, string | undefined>();
    if (Array.isArray(persisted))
      for (const key of persisted)
        if (typeof key === 'string' && !pendingRemovals.has(key) && !entries.has(key)) merged.set(key, undefined);
    for (const [key, value] of entries) merged.set(key, value);
    entries = merged;
    persistedIndex = raw ?? undefined;
    indexReady = true;
  }

  /** Writes the index (live keys, and dropped keys whose values are not yet deleted); false when it failed. */
  async function writeIndex(): Promise<boolean> {
    const listed = JSON.stringify([...entries.keys(), ...[...pendingRemovals].filter((key) => !entries.has(key))]);
    if (listed === persistedIndex) return true;
    try {
      await backend.setItem(INDEX_ITEM, listed);
    } catch {
      indexReady = false;
      persistedIndex = undefined;
      return false;
    }
    persistedIndex = listed;
    return true;
  }

  async function sync(): Promise<void> {
    readIndex();
    if (!indexReady || !(await writeIndex())) return;
    for (const key of [...pendingRemovals]) {
      try {
        await backend.deleteItem(itemNameOf(key));
      } catch {
        return;
      }
      if (!entries.has(key)) pendingRemovals.delete(key);
    }
    for (const [key, value] of [...pendingValues]) {
      try {
        await backend.setItem(itemNameOf(key), value);
      } catch {
        return;
      }
      if (pendingValues.get(key) === value) pendingValues.delete(key);
    }
    await writeIndex();
  }

  function enqueueSync(): void {
    queue = queue.then(sync).catch(() => undefined);
  }

  function valueOf(key: string): string | null {
    if (!entries.has(key)) readIndex();
    if (!entries.has(key)) return null;
    const cached = entries.get(key);
    if (cached !== undefined) return cached;
    let stored: string | null;
    try {
      stored = backend.getItem(itemNameOf(key));
    } catch {
      // Unreadable now: a miss, and the entry stays for a later read.
      return null;
    }
    if (stored === null) {
      entries.delete(key);
      return null;
    }
    entries.set(key, stored);
    characters += stored.length;
    return stored;
  }

  function drop(key: string): void {
    const cached = entries.get(key);
    if (cached !== undefined) characters -= cached.length;
    entries.delete(key);
    pendingValues.delete(key);
    pendingRemovals.add(key);
  }

  function evictOldestUntilWithinLimits(keep: string): void {
    for (const key of [...entries.keys()]) {
      if (entries.size <= limits.maxEntries && characters <= limits.maxCharacters) return;
      if (key !== keep) drop(key);
    }
  }

  function removeItem(key: string): void {
    readIndex();
    if (!entries.has(key)) return;
    drop(key);
    enqueueSync();
  }

  function setItem(key: string, value: string): void {
    if (value.length > limits.maxCharacters) {
      // A value that could never fit would evict everything else for nothing.
      removeItem(key);
      return;
    }
    readIndex();
    const previous = entries.get(key);
    if (previous !== undefined) characters -= previous.length;
    entries.delete(key);
    entries.set(key, value);
    characters += value.length;
    pendingRemovals.delete(key);
    pendingValues.set(key, value);
    evictOldestUntilWithinLimits(key);
    enqueueSync();
  }

  return {
    keys: () => {
      readIndex();
      return [...entries.keys()];
    },
    getItem: valueOf,
    setItem,
    removeItem,
    flush: () => queue,
  };
}
