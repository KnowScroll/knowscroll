import { createAccountScope } from '@knowscroll/client-core';
import { waitFor } from '@testing-library/react-native';
import { createNativeScopeDurability, type NativeDurabilityPorts } from './native-scope-durability';

/** Controlled commit/crypto ports, NOT native disk/Keystore/cryptography acceptance. */
const id = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const account = { accountId: id(1), universeId: id(2), privacyEpoch: 1, email: 'durability@fixture.test' };
const input = { account, origin: 'https://native.fixture.test', credential: 'fixture-session-a' };
const prefix = `ks.scope.${account.accountId}:1.`;
const pendingKey = prefix + 'recording.policy.pending.v1';
const command = JSON.stringify({
  version: 'recording-policy.v1',
  commandId: id(3),
  expectedPrivacyEpoch: 1,
  expectedRecordingGeneration: 3,
  on: false,
});
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
function fixture() {
  type Row = { root_id: string; revision: number; body: string };
  let root: string | null = null,
    row: Row | null = null;
  let commitGate: Promise<void> | undefined, encryptGate: Promise<void> | undefined;
  let failCommit = false,
    failRoot = false,
    casMiss = false,
    sync = 2,
    journal = 'wal',
    next = 10;
  let activeSeals = 0,
    peakSeals = 0;
  const queries: string[] = [],
    roots: string[] = [],
    seals = new Map<string, { value: string; key: string; aad: number[] }>();
  const ports: NativeDurabilityPorts = {
    open: () => {
      let draft: Row | null = null;
      return Promise.resolve({
        closeAsync: () => Promise.resolve(),
        getFirstAsync<T>(query: string) {
          if (query.includes('journal_mode')) return Promise.resolve({ journal_mode: journal } as T);
          if (query.includes('synchronous')) return Promise.resolve({ synchronous: sync } as T);
          return Promise.resolve(row ? ({ ...row } as T) : null);
        },
        async runAsync(query, ...params) {
          queries.push(query);
          if (query === 'BEGIN IMMEDIATE') draft = row ? { ...row } : null;
          if (query.startsWith('INSERT')) {
            if (draft) throw new Error('fixture duplicate row');
            draft = { root_id: String(params[0]), revision: Number(params[1]), body: String(params[2]) };
          }
          if (query.startsWith('UPDATE')) {
            if (casMiss || !draft || draft.root_id !== params[2] || draft.revision !== params[3]) return { changes: 0 };
            draft = { ...draft, revision: Number(params[0]), body: String(params[1]) };
          }
          if (query.startsWith('DELETE')) draft = null;
          if (query === 'COMMIT') {
            await commitGate;
            if (failCommit) throw new Error('fixture IO');
            row = draft ? { ...draft } : null;
          }
          return { changes: 1 };
        },
      });
    },
    readRoot: () => {
      if (failRoot) return Promise.reject(new Error('fixture locked'));
      return Promise.resolve(root);
    },
    writeRoot: (value) => {
      if (failRoot) return Promise.reject(new Error('fixture root commit'));
      root = value;
      roots.push(value);
      return Promise.resolve();
    },
    key: () => Promise.resolve('A'.repeat(43) + '='),
    id: () => Promise.resolve(id(next++)),
    binding: (value) => Promise.resolve((value === input.credential ? 'a' : 'b').repeat(64)),
    encrypt: async (value, key, aad) => {
      activeSeals++;
      peakSeals = Math.max(peakSeals, activeSeals);
      try {
        await encryptGate;
        const token = `opaque-fixture-${next++}`;
        seals.set(token, { value, key, aad: [...aad] });
        return token;
      } finally {
        activeSeals--;
      }
    },
    decrypt: (token, key, aad) => {
      const seal = seals.get(token);
      if (!seal || seal.key !== key || JSON.stringify(seal.aad) !== JSON.stringify([...aad]))
        return Promise.reject(new Error('fixture tag'));
      return Promise.resolve(seal.value);
    },
  };
  return {
    ports,
    queries,
    roots,
    seals,
    root: () => root,
    row: () => row,
    loseRow: () => {
      row = null;
    },
    changeRoot: (value: string | null) => {
      root = value;
    },
    changeRow: (value: Row) => {
      row = value;
    },
    casMiss: () => {
      casMiss = true;
    },
    sealActivity: () => ({ active: activeSeals, peak: peakSeals }),
    holdCommit: (value?: Promise<void>) => {
      commitGate = value;
    },
    holdEncrypt: (value?: Promise<void>) => {
      encryptGate = value;
    },
    failCommit: (value: boolean) => {
      failCommit = value;
    },
    failRoot: (value: boolean) => {
      failRoot = value;
    },
    settings: (value: number, name = 'wal') => {
      sync = value;
      journal = name;
    },
  };
}

describe('native scoped snapshot protocol (controlled-port fixtures)', () => {
  it('commits before preparation returns, then restores exact pending bytes across a new owner without policy authority', async () => {
    const f = fixture(),
      first = createNativeScopeDurability(f.ports);
    const store = await first.prepare(input, () => true);
    expect(f.queries).toContain('COMMIT');
    store.setItem(pendingKey, command);
    expect(await store.durability!.flush({ [pendingKey]: command })).toBe(true);
    const ciphertext = f.row()!.body;
    expect(ciphertext).not.toContain('recording-policy');
    const restored = await createNativeScopeDurability(f.ports).prepare(input, () => true);
    expect(restored.getItem(pendingKey)).toBe(command);
    expect(restored.keys()).toEqual([pendingKey]);
    expect(restored.keys().some((key) => key.endsWith('recording.policy.on'))).toBe(false);
  });
  it('does not acknowledge a pending body before actual COMMIT completion', async () => {
    const f = fixture(),
      store = await createNativeScopeDurability(f.ports).prepare(input, () => true),
      held = gate();
    f.holdCommit(held.promise);
    store.setItem(pendingKey, command);
    let complete = false;
    const committing = store.durability!.flush({ [pendingKey]: command }).then((value) => {
      complete = true;
      return value;
    });
    await waitFor(() => expect(f.queries.filter((q) => q === 'COMMIT')).toHaveLength(2));
    expect(complete).toBe(false);
    held.open();
    expect(await committing).toBe(true);
  });
  it('refuses every OPEN root with a missing snapshot, without minting a new key/root', async () => {
    const f = fixture();
    await createNativeScopeDurability(f.ports).prepare(input, () => true);
    const previous = f.root();
    f.loseRow();
    await expect(createNativeScopeDurability(f.ports).prepare(input, () => true)).rejects.toThrow(
      'NATIVE_SCOPED_STORAGE_UNAVAILABLE',
    );
    expect(f.root()).toBe(previous);
    expect(f.roots).toHaveLength(1);
  });
  it.each(['mode', 'sync'] as const)(
    'refuses an unsupported %s without a root write or memory fallback',
    async (mode) => {
      const f = fixture();
      f.settings(mode === 'sync' ? 1 : 2, mode === 'mode' ? 'delete' : 'wal');
      await expect(createNativeScopeDurability(f.ports).prepare(input, () => true)).rejects.toThrow();
      expect(f.roots).toEqual([]);
    },
  );
  it('preserves the last committed pending choice on IO failure and inhibits further persistence', async () => {
    const f = fixture(),
      store = await createNativeScopeDurability(f.ports).prepare(input, () => true);
    store.setItem(pendingKey, command);
    expect(await store.durability!.flush({ [pendingKey]: command })).toBe(true);
    f.failCommit(true);
    store.removeItem(pendingKey);
    expect(await store.durability!.flush({ [pendingKey]: undefined })).toBe(false);
    expect(store.durability!.healthy()).toBe(false);
    expect(f.queries).toContain('ROLLBACK');
    f.failCommit(false);
    const recovered = await createNativeScopeDurability(f.ports).prepare(input, () => true);
    expect(recovered.getItem(pendingKey)).toBe(command);
  });
  it('writes a keyless CLOSED record before deletion, denies same binding, and permits actual changed epoch after cleanup', async () => {
    const f = fixture(),
      owner = createNativeScopeDurability(f.ports);
    await owner.prepare(input, () => true);
    const original = f.root();
    await owner.purge();
    expect(JSON.parse(f.root()!)).toMatchObject({ status: 'closed' });
    expect(JSON.parse(f.root()!)).not.toHaveProperty('key');
    expect(f.row()).toBeNull();
    await expect(owner.prepare(input, () => true)).rejects.toThrow();
    const next = await owner.prepare({ ...input, account: { ...account, privacyEpoch: 2 } }, () => true);
    expect(next.durability!.healthy()).toBe(true);
    expect(f.root()).not.toBe(original);
    expect(JSON.parse(f.root()!)).toMatchObject({ privacyEpoch: 2, status: 'open' });
  });
  it('fences pending encryption and late old cleanup before another root can be published', async () => {
    const f = fixture(),
      owner = createNativeScopeDurability(f.ports),
      store = await owner.prepare(input, () => true),
      held = gate();
    f.holdEncrypt(held.promise);
    store.setItem(pendingKey, command);
    const pending = store.durability!.flush({ [pendingKey]: command });
    owner.fence();
    const cleanup = owner.purge();
    held.open();
    expect(await pending).toBe(false);
    await cleanup;
    const newer = await owner.prepare({ ...input, credential: 'fixture-session-b' }, () => true),
      root = f.root();
    await store.durability!.purge();
    expect(f.root()).toBe(root);
    expect(newer.durability!.healthy()).toBe(true);
  });
  it('never publishes a delayed hydration whose actual manager generation ended', async () => {
    const f = fixture(),
      held = gate();
    let live = true;
    const owner = createNativeScopeDurability({
      ...f.ports,
      binding: async (credential) => {
        await held.promise;
        return f.ports.binding(credential);
      },
    });
    const preparing = owner.prepare(input, () => live);
    live = false;
    owner.fence();
    held.open();
    await expect(preparing).rejects.toThrow();
    expect(f.roots).toEqual([]);
  });
  it('fails closed on locked secure storage instead of treating it as an empty account', async () => {
    const f = fixture();
    f.failRoot(true);
    await expect(createNativeScopeDurability(f.ports).prepare(input, () => true)).rejects.toThrow();
    expect(f.row()).toBeNull();
    expect(f.roots).toEqual([]);
  });
  it('binds exact domain-separated length-prefixed identity bytes to ciphertext', async () => {
    const f = fixture();
    await createNativeScopeDurability(f.ports).prepare(input, () => true);
    const seal = f.seals.get(f.row()!.body)!,
      bytes = Uint8Array.from(seal.aad);
    const view = new DataView(bytes.buffer);
    const first = view.getUint32(0, false);
    expect(new TextDecoder().decode(bytes.slice(4, 4 + first))).toBe('ks.native.scope-snapshot.v1');
    seal.aad[0] = 255;
    await expect(createNativeScopeDurability(f.ports).prepare(input, () => true)).rejects.toThrow();
  });
  it('keeps hints memory-only and commits a complete grouped block value/index', async () => {
    const f = fixture(),
      store = await createNativeScopeDurability(f.ports).prepare(input, () => true);
    store.setItem(prefix + 'recording.policy.signal', id(9));
    const stateKey = prefix + `scroll.block.${id(4)}.1.panel-open`,
      indexKey = prefix + `scroll.block.index.${id(4)}.panel-open`;
    store.durability!.group(() => {
      store.setItem(stateKey, JSON.stringify({ type: 'disclosure', expanded: true }));
      store.setItem(indexKey, '[1]');
    });
    expect(
      await store.durability!.flush({
        [stateKey]: JSON.stringify({ type: 'disclosure', expanded: true }),
        [indexKey]: '[1]',
      }),
    ).toBe(true);
    const restored = await createNativeScopeDurability(f.ports).prepare(input, () => true);
    expect(restored.getItem(stateKey)).toBe(JSON.stringify({ type: 'disclosure', expanded: true }));
    expect(restored.getItem(indexKey)).toBe('[1]');
    expect(restored.getItem(prefix + 'recording.policy.signal')).toBeNull();
  });
  it('refuses duplicate snapshot entries and malformed native data rather than silently discarding pending state', async () => {
    const f = fixture();
    await createNativeScopeDurability(f.ports).prepare(input, () => true);
    const seal = f.seals.get(f.row()!.body)!;
    seal.value = JSON.stringify({
      v: 1,
      revision: '1',
      entries: [
        ['recording.policy.pending.v1', command],
        ['recording.policy.pending.v1', command],
      ],
    });
    await expect(createNativeScopeDurability(f.ports).prepare(input, () => true)).rejects.toThrow();
    expect(f.roots).toHaveLength(1);
  });
});

it.each([
  'missing',
  'key_missing',
  'key_wrong',
  'version',
  'account',
  'epoch',
  'origin',
  'revision',
  'ciphertext',
] as const)(
  'native restored %s corruption refuses without replacing unresolved state (controlled ports)',
  async (mode) => {
    const f = fixture(),
      store = await createNativeScopeDurability(f.ports).prepare(input, () => true);
    store.setItem(pendingKey, command);
    expect(await store.durability!.flush({ [pendingKey]: command })).toBe(true);
    const root = JSON.parse(f.root()!) as Record<string, unknown>,
      row = f.row()!,
      before = f.roots.length;
    if (mode === 'missing') f.changeRoot(null);
    if (mode === 'key_missing') {
      delete root.key;
      f.changeRoot(JSON.stringify(root));
    }
    if (mode === 'key_wrong') {
      root.key = 'B'.repeat(43) + '=';
      f.changeRoot(JSON.stringify(root));
    }
    if (mode === 'version') {
      root.v = 2;
      f.changeRoot(JSON.stringify(root));
    }
    // Row/root identity and authenticated AAD disagree; do not call fresh auth with another binding.
    if (mode === 'account') f.changeRow({ ...row, root_id: id(999) });
    if (mode === 'epoch') {
      root.privacyEpoch = 0;
      f.changeRoot(JSON.stringify(root));
    }
    if (mode === 'origin') {
      root.origin = 'not-an-origin';
      f.changeRoot(JSON.stringify(root));
    }
    if (mode === 'revision') f.changeRow({ ...row, revision: row.revision + 1 });
    if (mode === 'ciphertext') f.changeRow({ ...row, body: 'invalid-seal' });
    await expect(createNativeScopeDurability(f.ports).prepare(input, () => true)).rejects.toThrow();
    expect(f.roots).toHaveLength(before);
    expect(f.row()).not.toBeNull();
  },
);

it('native zero-row CAS and revision exhaustion never acknowledge a new pending body (controlled ports)', async () => {
  const f = fixture(),
    store = await createNativeScopeDurability(f.ports).prepare(input, () => true);
  const before = f.row();
  f.casMiss();
  store.setItem(pendingKey, command);
  expect(await store.durability!.flush({ [pendingKey]: command })).toBe(false);
  expect(f.row()).toEqual(before);
  expect(store.durability!.healthy()).toBe(false);
  const g = fixture();
  await createNativeScopeDurability(g.ports).prepare(input, () => true);
  const row = g.row()!,
    seal = g.seals.get(row.body)!;
  g.changeRow({ ...row, revision: Number.MAX_SAFE_INTEGER });
  seal.value = JSON.stringify({ v: 1, revision: String(Number.MAX_SAFE_INTEGER), entries: [] });
  // The controlled cipher still enforces the exact new AAD revision.
  const parts = [
    'ks.native.scope-snapshot.v1',
    input.origin,
    account.accountId,
    '1',
    (JSON.parse(g.root()!) as { rootId: string }).rootId,
    String(Number.MAX_SAFE_INTEGER),
  ];
  seal.aad = parts.flatMap((part) => {
    const bytes = [...new TextEncoder().encode(part)];
    return [0, 0, 0, bytes.length, ...bytes];
  });
  const exhausted = await createNativeScopeDurability(g.ports).prepare(input, () => true);
  exhausted.setItem(pendingKey, command);
  expect(await exhausted.durability!.flush({ [pendingKey]: command })).toBe(false);
  expect(exhausted.durability!.healthy()).toBe(false);
  expect(g.row()!.revision).toBe(Number.MAX_SAFE_INTEGER);
});

it('native writer coalesces fast bounded convenience changes while preserving exact protected membership (controlled ports)', async () => {
  const f = fixture(),
    store = await createNativeScopeDurability(f.ports).prepare(input, () => true),
    held = gate();
  f.holdEncrypt(held.promise);
  store.setItem(pendingKey, command);
  const first = store.durability!.flush({ [pendingKey]: command });
  await waitFor(() => expect(f.sealActivity().active).toBe(1));
  for (let n = 1; n <= 80; n++) store.setItem(prefix + `scroll.anchor.${id(100 + n)}.1`, 'panel-open');
  expect(f.sealActivity().peak).toBe(1);
  expect(store.keys().filter((key) => key.includes('scroll.anchor.'))).toHaveLength(24);
  expect(store.getItem(pendingKey)).toBe(command);
  held.open();
  expect(await first).toBe(true);
  f.holdEncrypt();
  // Await observable latest membership rather than guessing how many microtasks the writer needs.
  await waitFor(async () =>
    expect(
      await store.durability!.flush({ [prefix + `scroll.anchor.${id(180)}.1`]: 'panel-open', [pendingKey]: command }),
    ).toBe(true),
  );
  expect(f.sealActivity().peak).toBe(1);
  const restored = await createNativeScopeDurability(f.ports).prepare(input, () => true);
  expect(restored.getItem(pendingKey)).toBe(command);
  expect(restored.keys().filter((key) => key.includes('scroll.anchor.'))).toHaveLength(24);
  expect(restored.getItem(prefix + `scroll.anchor.${id(101)}.1`)).toBeNull();
  expect(restored.getItem(prefix + `scroll.anchor.${id(180)}.1`)).toBe('panel-open');
});

it('native root write or RNG failure cannot fall back to a successful memory scope (controlled ports)', async () => {
  const f = fixture();
  await expect(
    createNativeScopeDurability({ ...f.ports, key: () => Promise.reject(new Error('RNG unavailable')) }).prepare(
      input,
      () => true,
    ),
  ).rejects.toThrow();
  expect(f.root()).toBeNull();
  expect(f.row()).toBeNull();
  await expect(
    createNativeScopeDurability({ ...f.ports, writeRoot: () => Promise.reject(new Error('commit false')) }).prepare(
      input,
      () => true,
    ),
  ).rejects.toThrow();
  expect(f.root()).toBeNull();
  expect(f.row()).toBeNull();
});

it('native failed cleanup retains a CLOSED marker and blocks same-binding resurrection until deletion retry (controlled ports)', async () => {
  const f = fixture(),
    owner = createNativeScopeDurability(f.ports);
  await owner.prepare(input, () => true);
  f.failCommit(true);
  await expect(owner.purge()).rejects.toThrow();
  expect(JSON.parse(f.root()!)).toMatchObject({ status: 'closed' });
  expect(JSON.parse(f.root()!)).not.toHaveProperty('key');
  expect(f.row()).not.toBeNull();
  await expect(owner.prepare(input, () => true)).rejects.toThrow();
  f.failCommit(false);
  await owner.purge();
  expect(f.row()).toBeNull();
  await expect(owner.prepare(input, () => true)).rejects.toThrow();
  const next = await owner.prepare({ ...input, credential: 'fixture-session-b' }, () => true);
  expect(next.durability!.healthy()).toBe(true);
});

it('native snapshot rejects a mismatched private resume and oversize protected input without writing either (controlled ports)', async () => {
  const f = fixture(),
    store = await createNativeScopeDurability(f.ports).prepare(input, () => true),
    before = f.row();
  expect(() =>
    store.setItem(
      prefix + `encounter.resume.${id(10)}.1`,
      JSON.stringify({
        kind: 'scroll',
        value: { assetId: id(11), revision: 1, blockId: 'panel-open', offsetWithinBlock: 0 },
      }),
    ),
  ).toThrow();
  expect(store.durability!.healthy()).toBe(false);
  expect(f.row()).toEqual(before);
  const g = fixture(),
    next = await createNativeScopeDurability(g.ports).prepare(input, () => true);
  expect(() => next.setItem(pendingKey, 'x'.repeat(4097))).toThrow();
  expect(next.durability!.healthy()).toBe(false);
});

it('native cleanup retries the CLOSED write instead of trusting a process-local read after false commit (controlled ports)', async () => {
  const f = fixture();
  let failClosed = true,
    closedWrites = 0;
  const owner = createNativeScopeDurability({
    ...f.ports,
    writeRoot: async (value) => {
      await f.ports.writeRoot(value);
      if ((JSON.parse(value) as { status: string }).status === 'closed') {
        closedWrites++;
        if (failClosed) throw new Error('fixture commit false after memory update');
      }
    },
  });
  await owner.prepare(input, () => true);
  await expect(owner.purge()).rejects.toThrow();
  expect(JSON.parse(f.root()!)).toMatchObject({ status: 'closed' });
  expect(f.row()).not.toBeNull();
  failClosed = false;
  await owner.purge();
  expect(closedWrites).toBe(2);
  expect(f.row()).toBeNull();
});

it('native close fences synchronous onEnd writes before preserving callback order and awaited deletion (controlled ports)', async () => {
  const f = fixture(),
    store = await createNativeScopeDurability(f.ports).prepare(input, () => true);
  store.setItem(pendingKey, command);
  expect(await store.durability!.flush({ [pendingKey]: command })).toBe(true);
  const scope = createAccountScope({
    account,
    baseUrl: input.origin,
    authorization: () => undefined,
    store,
    fetch: () => Promise.reject(new Error('no network in native close fixture')),
  });
  let activeDuringEnd: boolean | undefined, attempt: Promise<boolean> | undefined;
  scope.onEnd!(() => {
    activeDuringEnd = scope.active;
    scope.storage.set('recording.policy.pending.v1', command);
    attempt = scope.storage.durability!.flush({ 'recording.policy.pending.v1': command });
  });
  scope.end();
  expect(activeDuringEnd).toBe(true);
  expect(scope.active).toBe(false);
  expect(await attempt).toBe(false);
  await scope.whenStorageClosed!();
  expect(f.row()).toBeNull();
  expect(JSON.parse(f.root()!)).toMatchObject({ status: 'closed' });
  scope.storage.set('recording.policy.pending.v1', command);
  expect(store.keys()).toEqual([]);
  expect(f.row()).toBeNull();
});

it('native restore rejects fabricated persisted collection permission rather than treating it as authority (controlled ports)', async () => {
  const f = fixture();
  await createNativeScopeDurability(f.ports).prepare(input, () => true);
  const seal = f.seals.get(f.row()!.body)!;
  seal.value = JSON.stringify({ v: 1, revision: '1', entries: [['recording.policy.on', 'true']] });
  await expect(createNativeScopeDurability(f.ports).prepare(input, () => true)).rejects.toThrow();
  expect(f.roots).toHaveLength(1);
});
