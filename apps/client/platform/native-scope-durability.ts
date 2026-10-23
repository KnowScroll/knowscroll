import { RecordingObservationBatchRequestSchema, SetRecordingPolicySchema } from '@knowscroll/contracts';
import { BlockState, LocalId } from '@knowscroll/scroll-model';
import type { KeyValueStore, ScopeStorageLifecycle, StorageDurability } from '@knowscroll/client-core';

const ROOT_KEY = 'ks.scope.root.v1';
const service = 'ks.scoped-durability.v1';
const maximum = 524288;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const utf8 = new TextEncoder();
const unavailable = () => new Error('NATIVE_SCOPED_STORAGE_UNAVAILABLE');
interface Root {
  v: 1;
  status: 'open' | 'closed';
  origin: string;
  accountId: string;
  privacyEpoch: number;
  rootId: string;
  sessionBinding: string;
  key?: string;
}
interface Row {
  root_id: string;
  revision: number;
  body: string;
}
interface NativeDatabase {
  closeAsync(): Promise<void>;
  runAsync(query: string, ...params: (string | number | null)[]): Promise<{ changes: number }>;
  getFirstAsync<T>(query: string, ...params: (string | number | null)[]): Promise<T | null>;
}
/** Controlled ports are fixture seams; defaults below always use actual native primitives. */
export interface NativeDurabilityPorts {
  open(): Promise<NativeDatabase>;
  readRoot(): Promise<string | null>;
  writeRoot(value: string): Promise<void>;
  key(): Promise<string>;
  id(): Promise<string>;
  binding(credential: string): Promise<string>;
  encrypt(value: string, key: string, aad: Uint8Array): Promise<string>;
  decrypt(value: string, key: string, aad: Uint8Array): Promise<string>;
}
/** Exact local codec. Field boundaries and identities participate in authenticated encryption. */
function codec(fields: readonly string[]): Uint8Array<ArrayBuffer> {
  const parts = fields.map((value) => utf8.encode(value));
  const out = new Uint8Array(parts.reduce((n, part) => n + 4 + part.length, 0));
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const part of parts) {
    view.setUint32(offset, part.length, false);
    offset += 4;
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
const actual: NativeDurabilityPorts = {
  open: async () => (await import('expo-sqlite')).openDatabaseAsync('ks-scoped-v1.db', { useNewConnection: true }),
  readRoot: async () => (await import('expo-secure-store')).getItemAsync(ROOT_KEY, { keychainService: service }),
  writeRoot: async (value) => {
    const secure = await import('expo-secure-store');
    await secure.setItemAsync(ROOT_KEY, value, {
      keychainService: service,
      keychainAccessible: secure.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      requireAuthentication: false,
    });
  },
  key: async () => {
    const crypto = await import('expo-crypto');
    return (await crypto.AESEncryptionKey.generate(crypto.AESKeySize.AES256)).encoded('base64');
  },
  id: async () => (await import('expo-crypto')).randomUUID(),
  binding: async (credential) => {
    const crypto = await import('expo-crypto');
    return [
      ...new Uint8Array(
        await crypto.digest(crypto.CryptoDigestAlgorithm.SHA256, codec(['ks.native.scoped-session.v1', credential])),
      ),
    ]
      .map((n) => n.toString(16).padStart(2, '0'))
      .join('');
  },
  encrypt: async (value, key, additionalData) => {
    const crypto = await import('expo-crypto');
    return (
      await crypto.aesEncryptAsync(utf8.encode(value), await crypto.AESEncryptionKey.import(key, 'base64'), {
        additionalData,
        nonce: { length: 12 },
        tagLength: 16,
      })
    ).combined('base64');
  },
  decrypt: async (value, key, additionalData) => {
    const crypto = await import('expo-crypto');
    return new TextDecoder('utf-8', { fatal: true }).decode(
      await crypto.aesDecryptAsync(
        crypto.AESSealedData.fromCombined(value, { ivLength: 12, tagLength: 16 }),
        await crypto.AESEncryptionKey.import(key, 'base64'),
        { additionalData },
      ),
    );
  },
};
function object(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).every((k) => keys.includes(k))
  );
}
function parseRoot(raw: string): Root {
  if (utf8.encode(raw).length > 1024) throw unavailable();
  const r: unknown = JSON.parse(raw);
  if (
    !object(r, ['v', 'status', 'origin', 'accountId', 'privacyEpoch', 'rootId', 'sessionBinding', 'key']) ||
    r.v !== 1 ||
    !['open', 'closed'].includes(String(r.status)) ||
    typeof r.origin !== 'string' ||
    new URL(r.origin).origin !== r.origin ||
    typeof r.accountId !== 'string' ||
    !uuid.test(r.accountId) ||
    typeof r.rootId !== 'string' ||
    !uuid.test(r.rootId) ||
    !Number.isInteger(r.privacyEpoch) ||
    Number(r.privacyEpoch) < 1 ||
    Number(r.privacyEpoch) > 2147483647 ||
    typeof r.sessionBinding !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(r.sessionBinding) ||
    (r.status === 'open' ? typeof r.key !== 'string' || !/^[A-Za-z0-9+/]{43}=$/u.test(r.key) : 'key' in r)
  )
    throw unavailable();
  return r as unknown as Root;
}
function aad(root: Root, revision: number) {
  return codec([
    'ks.native.scope-snapshot.v1',
    root.origin,
    root.accountId,
    String(root.privacyEpoch),
    root.rootId,
    String(revision),
  ]);
}
function category(key: string): 'protected' | 'state' | 'index' | 'anchor' | 'resume' | undefined {
  if (key === 'recording.policy.pending.v1' || key === 'recorder.outbox.v2') return 'protected';
  const id = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}',
    rev = '[1-9][0-9]{0,9}',
    block = '[a-z][a-z0-9-]{1,39}';
  if (new RegExp(`^scroll\\.block\\.${id}\\.${rev}\\.${block}$`).test(key) && Number(key.split('.')[3]) <= 2147483647)
    return 'state';
  if (new RegExp(`^scroll\\.block\\.index\\.${id}\\.${block}$`).test(key)) return 'index';
  if (new RegExp(`^scroll\\.anchor\\.${id}\\.${rev}$`).test(key) && Number(key.split('.').at(-1)) <= 2147483647)
    return 'anchor';
  if (new RegExp(`^encounter\\.resume\\.${id}\\.${rev}$`).test(key) && Number(key.split('.').at(-1)) <= 2147483647)
    return 'resume';
  return undefined;
}
function validValue(key: string, raw: string, epoch: number): boolean {
  const kind = category(key);
  if (!kind || utf8.encode(raw).length > 270336) return false;
  if (kind === 'anchor') return LocalId.safeParse(raw).success;
  try {
    const v: unknown = JSON.parse(raw);
    if (key === 'recording.policy.pending.v1') {
      const parsed = SetRecordingPolicySchema.safeParse(v);
      return utf8.encode(raw).length <= 4096 && parsed.success && parsed.data.expectedPrivacyEpoch === epoch;
    }
    if (key === 'recorder.outbox.v2')
      return (
        object(v, ['v', 'dropped', 'legacyDiscarded', 'batches']) &&
        v.v === 2 &&
        typeof v.legacyDiscarded === 'boolean' &&
        Number.isSafeInteger(v.dropped) &&
        Number(v.dropped) >= 0 &&
        Array.isArray(v.batches) &&
        v.batches.length <= 40 &&
        utf8.encode(raw).length <= 262144 &&
        v.batches.every((b) => RecordingObservationBatchRequestSchema.safeParse(b).success)
      );
    if (kind === 'state') return utf8.encode(raw).length <= 1024 && BlockState.safeParse(v).success;
    if (kind === 'index')
      return (
        Array.isArray(v) &&
        v.length <= 4 &&
        v.every((n, i) => Number.isInteger(n) && n > 0 && n <= 2147483647 && (i === 0 || n > Number(v[i - 1])))
      );
    if (!object(v, ['kind', 'positionMs', 'value'])) return false;
    if (v.kind === 'reel')
      return (
        Object.keys(v).length === 2 &&
        typeof v.positionMs === 'number' &&
        Number.isFinite(v.positionMs) &&
        v.positionMs >= 0
      );
    const x = v.value;
    return (
      v.kind === 'scroll' &&
      Object.keys(v).length === 2 &&
      object(x, ['assetId', 'revision', 'blockId', 'offsetWithinBlock']) &&
      Object.keys(x).length === 4 &&
      typeof x.assetId === 'string' &&
      uuid.test(x.assetId) &&
      Number.isInteger(x.revision) &&
      Number(x.revision) > 0 &&
      LocalId.safeParse(x.blockId).success &&
      typeof x.offsetWithinBlock === 'number' &&
      Number.isFinite(x.offsetWithinBlock) &&
      x.offsetWithinBlock >= 0 &&
      key === `encounter.resume.${x.assetId}.${String(x.revision)}`
    );
  } catch {
    return false;
  }
}
function parseSnapshot(raw: string, root: Root, revision: number): Map<string, string> {
  if (utf8.encode(raw).length > maximum) throw unavailable();
  const parsed: unknown = JSON.parse(raw);
  if (
    !object(parsed, ['v', 'revision', 'entries']) ||
    parsed.v !== 1 ||
    parsed.revision !== String(revision) ||
    !Array.isArray(parsed.entries) ||
    parsed.entries.length > 256
  )
    throw unavailable();
  const result = new Map<string, string>();
  let previous = '';
  for (const entry of parsed.entries) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== 'string' ||
      typeof entry[1] !== 'string' ||
      entry[0] <= previous ||
      !validValue(entry[0], entry[1], root.privacyEpoch)
    )
      throw unavailable();
    previous = entry[0];
    result.set(entry[0], entry[1]);
  }
  for (const [kind, limit] of Object.entries({ state: 96, index: 96, anchor: 24, resume: 24 }))
    if ([...result.keys()].filter((k) => category(k) === kind).length > limit) throw unavailable();
  for (const [key, value] of result) {
    const parts = key.split('.');
    if (category(key) === 'index') {
      const revisions = JSON.parse(value) as number[];
      if (revisions.some((rev) => !result.has(`scroll.block.${parts[3]}.${rev}.${parts[4]}`))) throw unavailable();
    }
    if (category(key) === 'state') {
      const raw = result.get(`scroll.block.index.${parts[2]}.${parts[4]}`);
      if (!raw || !(JSON.parse(raw) as number[]).includes(Number(parts[3]))) throw unavailable();
    }
  }
  return result;
}
interface Runtime {
  readonly root: Root;
  readonly store: KeyValueStore;
  readonly port: StorageDurability;
}

/** One database connection/writer. Persisted data is never policy or authentication authority. */
export function createNativeScopeDurability(ports: NativeDurabilityPorts = actual): ScopeStorageLifecycle {
  let db: Promise<NativeDatabase> | undefined;
  let tail = Promise.resolve();
  let incarnation = 0;
  let runtime: Runtime | undefined;
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const result = tail.then(work);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  async function database() {
    db ??= (async () => {
      const value = await ports.open();
      try {
        const journal = await value.getFirstAsync<{ journal_mode: string }>('PRAGMA journal_mode=WAL');
        await value.runAsync('PRAGMA synchronous=FULL');
        const sync = await value.getFirstAsync<{ synchronous: number }>('PRAGMA synchronous');
        if (journal?.journal_mode !== 'wal' || sync?.synchronous !== 2) throw unavailable();
        await value.runAsync(
          'CREATE TABLE IF NOT EXISTS ks_scoped_snapshot (singleton INTEGER PRIMARY KEY CHECK(singleton=1),root_id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>=1 AND revision<=9007199254740991),body TEXT NOT NULL CHECK(length(body)<=710000))',
        );
        return value;
      } catch (error) {
        try {
          await value.closeAsync();
        } catch {
          /* Preserve the initialization failure. */
        }
        throw error;
      }
    })().catch((error) => {
      db = undefined;
      throw error;
    });
    return db;
  }
  async function transaction(work: (db: NativeDatabase) => Promise<void>) {
    const value = await database();
    await value.runAsync('BEGIN IMMEDIATE');
    try {
      await work(value);
      await value.runAsync('COMMIT');
    } catch (error) {
      try {
        await value.runAsync('ROLLBACK');
      } catch {
        /* original failure */
      }
      throw error;
    }
  }
  async function close(rootId?: string) {
    const raw = await ports.readRoot();
    const root = raw === null ? undefined : parseRoot(raw);
    if (rootId !== undefined && root?.rootId !== rootId) return; // Late old cleanup never touches a replacement.
    if (root) {
      const { key: _key, ...rest } = root;
      // A failed SharedPreferences commit can still change its process-local read view.
      // Even an already-CLOSED read needs a successful write acknowledgement on cleanup retry.
      await ports.writeRoot(JSON.stringify({ ...rest, status: 'closed' }));
    }
    await transaction(async (value) => {
      await value.runAsync('DELETE FROM ks_scoped_snapshot WHERE singleton=1');
    });
    const connection = db;
    db = undefined;
    await (await connection)?.closeAsync();
  }
  function makeRuntime(root: Root, initial: Map<string, string>, initialRevision: number): Runtime {
    const prefix = `ks.scope.${root.accountId}:${root.privacyEpoch}.`;
    const mirror = new Map(initial),
      ephemeral = new Map<string, string>();
    let committed = new Map(initial),
      revision = initialRevision,
      dirty = false,
      closed = false,
      healthy = true,
      grouped = 0;
    let scheduled = false;
    let writing: Promise<boolean> | undefined, purging: Promise<void> | undefined;
    const listeners = new Set<() => void>();
    const ages = new Map([...mirror.keys()].map((k) => [k, 0]));
    let age = 0;
    const fail = () => {
      healthy = false;
      for (const listener of [...listeners]) listener();
    };
    const bounded = () => {
      const limits = { state: 96, index: 96, anchor: 24, resume: 24 };
      const removeGroup = (key: string) => {
        const parts = key.split('.');
        if (category(key) === 'state' || category(key) === 'index') {
          const asset = category(key) === 'index' ? parts[3] : parts[2],
            block = parts.at(-1);
          for (const candidate of mirror.keys()) {
            const bits = candidate.split('.');
            if (
              (category(candidate) === 'state' && bits[2] === asset && bits.at(-1) === block) ||
              candidate === `scroll.block.index.${asset}.${block}`
            ) {
              mirror.delete(candidate);
              ages.delete(candidate);
            }
          }
        } else {
          mirror.delete(key);
          ages.delete(key);
        }
      };
      const oldest = (keys: string[]) =>
        keys.sort((a, b) => (ages.get(a) ?? 0) - (ages.get(b) ?? 0) || (a < b ? -1 : a > b ? 1 : 0))[0];
      for (const [kind, limit] of Object.entries(limits)) {
        let keys = [...mirror.keys()].filter((k) => category(k) === kind);
        while (keys.length > limit) {
          removeGroup(oldest(keys)!);
          keys = [...mirror.keys()].filter((k) => category(k) === kind);
        }
      }
      const serialized = () =>
        JSON.stringify({
          v: 1,
          revision: String(revision + 1),
          entries: [...mirror].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        });
      while (mirror.size > 256 || utf8.encode(serialized()).length > maximum) {
        const key = oldest([...mirror.keys()].filter((k) => category(k) !== 'protected'));
        if (!key) throw unavailable();
        removeGroup(key);
      }
    };
    async function write(): Promise<boolean> {
      if (closed || !healthy) return false;
      if (writing) return writing;
      if (!dirty) return true;
      if (grouped) return false;
      bounded();
      const snapshot = new Map(mirror),
        previous = revision,
        next = previous + 1;
      if (!Number.isSafeInteger(next)) {
        fail();
        return false;
      }
      dirty = false;
      writing = exclusive(async () => {
        try {
          const plain = JSON.stringify({
            v: 1,
            revision: String(next),
            entries: [...snapshot].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
          });
          parseSnapshot(plain, root, next);
          const ciphertext = await ports.encrypt(plain, root.key!, aad(root, next));
          if (closed || !healthy || ciphertext.length > 710000) throw unavailable();
          await transaction(async (value) => {
            if (closed) throw unavailable();
            const updated =
              previous === 0
                ? await value.runAsync(
                    'INSERT INTO ks_scoped_snapshot(singleton,root_id,revision,body) VALUES(1,?,?,?)',
                    root.rootId,
                    next,
                    ciphertext,
                  )
                : await value.runAsync(
                    'UPDATE ks_scoped_snapshot SET revision=?,body=? WHERE singleton=1 AND root_id=? AND revision=?',
                    next,
                    ciphertext,
                    root.rootId,
                    previous,
                  );
            if (updated.changes !== 1 || closed) throw unavailable();
          });
          if (closed) return false;
          revision = next;
          committed = snapshot;
          return true;
        } catch {
          fail();
          return false;
        } finally {
          writing = undefined;
          if (dirty && healthy && !closed) schedule();
        }
      });
      return writing;
    }
    function schedule() {
      if (!grouped && !closed && healthy && !scheduled) {
        scheduled = true;
        void Promise.resolve()
          .then(() => {
            scheduled = false;
            return write();
          })
          .catch(fail);
      }
    }
    const port: StorageDurability = {
      async flush(expected) {
        try {
          if (!(await write()) || closed || !healthy) return false;
        } catch {
          fail();
          return false;
        }
        return Object.entries(expected).every(
          ([full, value]) =>
            full.startsWith(prefix) &&
            committed.get(full.slice(prefix.length)) === value &&
            mirror.get(full.slice(prefix.length)) === value,
        );
      },
      group(work) {
        grouped++;
        try {
          work();
        } finally {
          grouped--;
          if (!grouped && dirty) schedule();
        }
      },
      healthy: () => healthy && !closed,
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      fence() {
        closed = true;
        mirror.clear();
        ephemeral.clear();
        for (const listener of [...listeners]) listener();
      },
      purge() {
        port.fence();
        purging ??= exclusive(() => close(root.rootId));
        return purging;
      },
    };
    const store: KeyValueStore = {
      durability: port,
      keys: () => (closed ? [] : [...mirror.keys(), ...ephemeral.keys()].map((k) => prefix + k)),
      getItem: (full) =>
        closed || !full.startsWith(prefix)
          ? null
          : (mirror.get(full.slice(prefix.length)) ?? ephemeral.get(full.slice(prefix.length)) ?? null),
      setItem(full, value) {
        if (closed || !full.startsWith(prefix)) return;
        const key = full.slice(prefix.length);
        if (!category(key)) {
          ephemeral.set(key, value);
          if (ephemeral.size > 256) ephemeral.delete(ephemeral.keys().next().value!);
          return;
        } // Never persisted.
        if (!healthy || !validValue(key, value, root.privacyEpoch)) {
          fail();
          throw unavailable();
        }
        if (!Number.isSafeInteger(age + 1)) {
          ages.clear();
          age = 0;
        }
        mirror.delete(key);
        mirror.set(key, value);
        ages.set(key, ++age);
        dirty = true;
        if (!grouped) {
          try {
            bounded();
          } catch {
            fail();
            throw unavailable();
          }
          schedule();
        }
      },
      removeItem(full) {
        if (!closed && full.startsWith(prefix)) {
          ephemeral.delete(full.slice(prefix.length));
          if (mirror.delete(full.slice(prefix.length))) {
            ages.delete(full.slice(prefix.length));
            dirty = true;
            schedule();
          }
        }
      },
    };
    if (initialRevision === 0) dirty = true;
    return { root, store, port };
  }
  return {
    fence() {
      incarnation++;
      runtime?.port.fence();
    },
    purge() {
      incarnation++;
      runtime?.port.fence();
      return exclusive(() => close());
    },
    async prepare(input, current) {
      const ticket = ++incarnation;
      const live = () => ticket === incarnation && current();
      const opened = await exclusive(async () => {
        if (
          !live() ||
          !input.credential ||
          !uuid.test(input.account.accountId) ||
          new URL(input.origin).origin !== input.origin
        )
          throw unavailable();
        const binding = await ports.binding(input.credential);
        if (!live()) throw unavailable();
        const raw = await ports.readRoot();
        if (!live()) throw unavailable();
        const root = raw === null ? undefined : parseRoot(raw);
        const value = await database();
        if (!live()) throw unavailable();
        const row = await value.getFirstAsync<Row>(
          'SELECT root_id,revision,body FROM ks_scoped_snapshot WHERE singleton=1',
        );
        if (!live()) throw unavailable();
        const same =
          root?.origin === input.origin &&
          root.accountId === input.account.accountId &&
          root.privacyEpoch === input.account.privacyEpoch &&
          root.sessionBinding === binding;
        if (root?.status === 'open') {
          // No prior-commit witness exists: missing means unknown, NEVER empty initialization.
          if (!row) throw unavailable();
          if (!same) {
            await close(root.rootId);
            if (!live()) throw unavailable();
          } else {
            if (
              row.root_id !== root.rootId ||
              !Number.isSafeInteger(row.revision) ||
              row.revision < 1 ||
              row.body.length > 710000
            )
              throw unavailable();
            const plaintext = await ports.decrypt(row.body, root.key!, aad(root, row.revision));
            if (!live()) throw unavailable();
            return makeRuntime(root, parseSnapshot(plaintext, root, row.revision), row.revision);
          }
        } else {
          if (same || (raw === null && row !== null) || (root && row && row.root_id !== root.rootId))
            throw unavailable();
          if (root) {
            await close(root.rootId);
            if (!live()) throw unavailable();
          }
        }
        const key = await ports.key();
        if (!live()) throw unavailable();
        const next: Root = {
          v: 1,
          status: 'open',
          origin: input.origin,
          accountId: input.account.accountId,
          privacyEpoch: input.account.privacyEpoch,
          rootId: await ports.id(),
          sessionBinding: binding,
          key,
        };
        if (!live()) throw unavailable();
        parseRoot(JSON.stringify(next));
        await ports.writeRoot(JSON.stringify(next));
        if (!live()) throw unavailable();
        return makeRuntime(next, new Map(), 0);
      });
      if (!live()) {
        opened.port.fence();
        await opened.port.purge();
        throw unavailable();
      }
      runtime = opened;
      if (!(await opened.port.flush({})) || !live()) {
        opened.port.fence();
        throw unavailable();
      }
      return opened.store;
    },
  };
}
