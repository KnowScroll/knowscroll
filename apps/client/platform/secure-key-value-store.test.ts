import { purgeStorage, scopeStoragePrefix, SCOPED_STORAGE_PREFIX } from '@knowscroll/client-core';
import { createSecureKeyValueStore, type SecureItemBackend } from './secure-key-value-store';

/** A labelled test double for the platform's encrypted storage: items in a map, failures on demand. */
function fakeBackend() {
  const items = new Map<string, string>();
  const calls: string[] = [];
  const failures = { reads: false, writes: false };
  const backend: SecureItemBackend = {
    getItem(name) {
      if (failures.reads) throw new Error('keystore locked');
      return items.get(name) ?? null;
    },
    async setItem(name, value) {
      calls.push(`set ${name}`);
      if (failures.writes) throw new Error('keystore locked');
      await Promise.resolve();
      items.set(name, value);
    },
    async deleteItem(name) {
      calls.push(`delete ${name}`);
      if (failures.writes) throw new Error('keystore locked');
      await Promise.resolve();
      items.delete(name);
    },
  };
  return { backend, items, calls, failures };
}

const scopeA = scopeStoragePrefix('account-a:1');
const scopeB = scopeStoragePrefix('account-b:1');
const names = (items: Map<string, string>) => [...items.keys()];

describe('the persistent scope store', () => {
  it('serves what a run wrote to the next run, from a fresh store over the same backend', async () => {
    const { backend } = fakeBackend();
    const first = createSecureKeyValueStore(backend);
    first.setItem(`${scopeA}universe.view.v1`, '{"camera":1}');
    first.setItem('ks.deletion.receipt', 'receipt-1');
    await first.flush();

    const restarted = createSecureKeyValueStore(backend);
    expect(restarted.getItem(`${scopeA}universe.view.v1`)).toBe('{"camera":1}');
    expect(restarted.getItem('ks.deletion.receipt')).toBe('receipt-1');
    expect(restarted.getItem('never.written')).toBeNull();
    expect([...restarted.keys()].sort()).toEqual(['ks.deletion.receipt', `${scopeA}universe.view.v1`].sort());
  });

  it('keeps every key out of the backend as written, and in the characters a secure store accepts', async () => {
    const { backend, items } = fakeBackend();
    const store = createSecureKeyValueStore(backend);
    store.setItem(`${scopeA}scroll.block/state:é`, 'x');
    await store.flush();
    expect(names(items).length).toBeGreaterThan(0);
    for (const name of items.keys()) expect(name).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(names(items).some((name) => name.includes('account-a'))).toBe(false);
  });

  it('purges one scope by its prefix, from memory and from the backend, leaving the others', async () => {
    const { backend, items } = fakeBackend();
    const store = createSecureKeyValueStore(backend);
    store.setItem(`${scopeA}one`, '1');
    store.setItem(`${scopeA}two`, '2');
    store.setItem(`${scopeB}one`, 'b');
    store.setItem('ks.deletion.receipt', 'receipt');
    purgeStorage(store, scopeA);
    expect(store.getItem(`${scopeA}one`)).toBeNull();
    await store.flush();
    expect(names(items)).toHaveLength(3); // scope B's value, the receipt and the index

    const restarted = createSecureKeyValueStore(backend);
    expect([...restarted.keys()].sort()).toEqual([`${scopeB}one`, 'ks.deletion.receipt'].sort());
    purgeStorage(restarted, SCOPED_STORAGE_PREFIX);
    await restarted.flush();
    expect(createSecureKeyValueStore(backend).keys()).toEqual(['ks.deletion.receipt']);
  });

  it('applies changes in the order they were made: a write after a purge survives', async () => {
    const { backend, calls } = fakeBackend();
    const store = createSecureKeyValueStore(backend);
    store.setItem(`${scopeA}key`, 'old');
    store.removeItem(`${scopeA}key`);
    store.setItem(`${scopeA}key`, 'new');
    await store.flush();
    const valueCalls = calls.filter((call) => !call.includes('ks.kv-index'));
    expect(valueCalls.map((call) => call.split(' ')[0])).toEqual(['set', 'delete', 'set']);
    expect(createSecureKeyValueStore(backend).getItem(`${scopeA}key`)).toBe('new');
  });

  it('writes a new key into the index before its value, and deletes a value before it leaves the index', async () => {
    const { backend, calls } = fakeBackend();
    const store = createSecureKeyValueStore(backend);
    store.setItem(`${scopeA}key`, 'v');
    await store.flush();
    const kind = (call: string) => (call.includes('ks.kv-index') ? 'index' : call.split(' ')[0]);
    expect(calls.map(kind)).toEqual(['index', 'set']);
    calls.length = 0;
    store.removeItem(`${scopeA}key`);
    await store.flush();
    expect(calls.map(kind)).toEqual(['delete', 'index']);
  });

  it('is bounded: past its limits the oldest written keys go, and the newest write stays', async () => {
    const { backend, items } = fakeBackend();
    const store = createSecureKeyValueStore(backend, { maxEntries: 3, maxCharacters: 10 });
    store.setItem('a', '1234');
    store.setItem('b', '1234');
    store.setItem('c', '12');
    expect(store.keys()).toEqual(['a', 'b', 'c']);
    store.setItem('d', '1234'); // 14 characters in four keys: `a` goes
    expect(store.keys()).toEqual(['b', 'c', 'd']);
    store.setItem('b', '1'); // rewriting makes `b` the newest
    store.setItem('e', '1');
    store.setItem('f', '1');
    expect(store.keys()).toEqual(['b', 'e', 'f']);
    await store.flush();
    expect(names(items)).toHaveLength(4); // three values and the index
    expect(createSecureKeyValueStore(backend).keys()).toEqual(['b', 'e', 'f']);
  });

  it('does not store a value larger than its whole budget, and forgets the old value of that key', async () => {
    const { backend } = fakeBackend();
    const store = createSecureKeyValueStore(backend, { maxEntries: 5, maxCharacters: 8 });
    store.setItem('small', 'ok');
    store.setItem('big', '123456789');
    store.setItem('small', '123456789');
    expect(store.getItem('big')).toBeNull();
    expect(store.getItem('small')).toBeNull();
    await store.flush();
    expect(createSecureKeyValueStore(backend).keys()).toEqual([]);
  });

  it('keeps serving from memory when the backend cannot be written, and tries again on the next change', async () => {
    const { backend, items, failures } = fakeBackend();
    const store = createSecureKeyValueStore(backend);
    failures.writes = true;
    store.setItem(`${scopeA}key`, 'v');
    await store.flush();
    expect(store.getItem(`${scopeA}key`)).toBe('v');
    expect(items.size).toBe(0);
    failures.writes = false;
    store.setItem(`${scopeA}other`, 'w');
    await store.flush();
    expect(createSecureKeyValueStore(backend).getItem(`${scopeA}other`)).toBe('w');
  });

  it('treats an unreadable backend as empty and an unreadable value as a miss that can recover', async () => {
    const { backend, failures } = fakeBackend();
    const writer = createSecureKeyValueStore(backend);
    writer.setItem('key', 'v');
    await writer.flush();

    failures.reads = true;
    expect(createSecureKeyValueStore(backend).keys()).toEqual([]);

    failures.reads = false;
    const reader = createSecureKeyValueStore(backend);
    expect(reader.keys()).toEqual(['key']);
    failures.reads = true;
    expect(reader.getItem('key')).toBeNull();
    failures.reads = false;
    expect(reader.getItem('key')).toBe('v');
  });

  it('ignores a corrupt index', () => {
    const { backend, items } = fakeBackend();
    items.set('ks.kv-index', '{"not":"a list"');
    expect(createSecureKeyValueStore(backend).keys()).toEqual([]);
    items.set('ks.kv-index', '{"not":"a list"}');
    expect(createSecureKeyValueStore(backend).keys()).toEqual([]);
  });
});
