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
 * - Changes reach the backend through one ordered queue, so a purge can never be overtaken by an
 *   earlier write of the same key. A change is durable a moment after the call returns, not at
 *   the call; a process killed in between loses that change only. A deleted value goes before its
 *   key leaves the index, and a new key joins the index before its value is written, so a kill
 *   in between leaves an index entry without a value, never a value nobody can find to purge.
 * - A backend that fails (a locked device, a lost key) loses persistence, not correctness: the
 *   store keeps serving from memory and the next change tries again.
 * - It is bounded: past `limits`, the oldest written keys are evicted from memory and the
 *   backend. Callers treat the store as a cache that can miss.
 *
 * `flush()` resolves when every queued change has reached the backend (tests; never awaited by
 * the app).
 */
export function createSecureKeyValueStore(
  backend: SecureItemBackend,
  limits: SecureStoreLimits = DEFAULT_SECURE_STORE_LIMITS,
): KeyValueStore & { flush(): Promise<void> } {
  /** Insertion order is write order: the first entry is the oldest. `undefined` = known, not loaded. */
  let entries: Map<string, string | undefined> | undefined;
  let characters = 0;
  let queue: Promise<void> = Promise.resolve();

  function enqueue(change: () => Promise<void>): void {
    queue = queue.then(change).catch(() => undefined);
  }

  function loadIndex(): Map<string, string | undefined> {
    if (entries !== undefined) return entries;
    entries = new Map();
    try {
      const parsed: unknown = JSON.parse(backend.getItem(INDEX_ITEM) ?? '[]');
      if (Array.isArray(parsed)) for (const key of parsed) if (typeof key === 'string') entries.set(key, undefined);
    } catch {
      // An unreadable index is an empty one.
    }
    return entries;
  }

  function saveIndex(): void {
    const snapshot = JSON.stringify([...loadIndex().keys()]);
    enqueue(() => backend.setItem(INDEX_ITEM, snapshot));
  }

  function valueOf(key: string): string | null {
    const known = loadIndex();
    if (!known.has(key)) return null;
    const cached = known.get(key);
    if (cached !== undefined) return cached;
    let stored: string | null;
    try {
      stored = backend.getItem(itemNameOf(key));
    } catch {
      // Unreadable now: a miss, and the entry stays for a later read.
      return null;
    }
    if (stored === null) {
      known.delete(key);
      return null;
    }
    known.set(key, stored);
    characters += stored.length;
    return stored;
  }

  function drop(key: string): void {
    const known = loadIndex();
    const cached = known.get(key);
    if (cached !== undefined) characters -= cached.length;
    known.delete(key);
    enqueue(() => backend.deleteItem(itemNameOf(key)));
  }

  function evictOldestUntilWithinLimits(keep: string): void {
    const known = loadIndex();
    for (const key of [...known.keys()]) {
      if (known.size <= limits.maxEntries && characters <= limits.maxCharacters) return;
      if (key !== keep) drop(key);
    }
  }

  function removeItem(key: string): void {
    if (!loadIndex().has(key)) return;
    drop(key);
    saveIndex();
  }

  function setItem(key: string, value: string): void {
    if (value.length > limits.maxCharacters) {
      // A value that could never fit would evict everything else for nothing.
      removeItem(key);
      return;
    }
    const known = loadIndex();
    const previous = known.get(key);
    if (previous !== undefined) characters -= previous.length;
    known.delete(key);
    known.set(key, value);
    characters += value.length;
    evictOldestUntilWithinLimits(key);
    saveIndex();
    enqueue(() => backend.setItem(itemNameOf(key), value));
  }

  return {
    keys: () => [...loadIndex().keys()],
    getItem: valueOf,
    setItem,
    removeItem,
    flush: () => queue,
  };
}
