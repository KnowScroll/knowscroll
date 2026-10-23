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
  interface Preparation {
    fenced: boolean;
    readonly secrets: Map<'credential' | 'key' | 'raw' | 'plaintext', string>;
    root?: Root;
    row?: Row;
    entries?: Map<string, string>;
    opened?: Runtime;
    rootId?: string;
    emptyRoot?: boolean;
    binding?: string;
  }
  const preparing = new Set<Preparation>();
  const release = (owner: Preparation) => {
    owner.fenced = true;
    owner.secrets.clear();
    delete owner.binding;
    delete owner.emptyRoot;
    if (owner.root) delete owner.root.key;
    delete owner.root;
    delete owner.row;
    owner.entries?.clear();
    delete owner.entries;
    owner.opened?.port.fence();
    delete owner.opened;
  };
  const releasePreparing = () => {
    for (const owner of preparing) release(owner);
    preparing.clear();
  };
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const result = tail.then(work);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  async function database(current: () => boolean = () => true) {
    if (!current()) throw unavailable();
    db ??= (async () => {
      const value = await ports.open();
      try {
        if (!current()) throw unavailable();
        const journal = await value.getFirstAsync<{ journal_mode: string }>('PRAGMA journal_mode=WAL');
        if (!current()) throw unavailable();
        await value.runAsync('PRAGMA synchronous=FULL');
        if (!current()) throw unavailable();
        const sync = await value.getFirstAsync<{ synchronous: number }>('PRAGMA synchronous');
        if (!current() || journal?.journal_mode !== 'wal' || sync?.synchronous !== 2) throw unavailable();
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
    const value = await db;
    if (!current()) throw unavailable();
    return value;
  }
  async function transaction(work: (db: NativeDatabase) => Promise<void>, current: () => boolean = () => true) {
    const value = await database(current);
    if (!current()) throw unavailable();
    await value.runAsync('BEGIN IMMEDIATE');
    try {
      if (!current()) throw unavailable();
      await work(value);
      if (!current()) throw unavailable();
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
    const input = { raw: await ports.readRoot() };
    const root = input.raw === null ? undefined : parseRoot(input.raw);
    input.raw = null;
    if (rootId !== undefined && root?.rootId !== rootId) return; // Late old cleanup never touches a replacement.
    if (root) {
      delete root.key;
      root.status = 'closed';
      // A failed SharedPreferences commit can still change its process-local read view.
      // Even an already-CLOSED read needs a successful write acknowledgement on cleanup retry.
      await ports.writeRoot(JSON.stringify(root));
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
      ephemeral = new Map<string, string>(),
      committed = new Map(initial),
      inFlightMaps = new Set<Map<string, string | undefined>>();
    initial.clear(); // Ownership transferred; do not retain a second hydrated plaintext map.
    let revision = initialRevision,
      dirty = false,
      closed = false,
      healthy = true,
      grouped = 0;
    let scheduled = false;
    let writing: Promise<boolean> | undefined, purging: Promise<void> | undefined;
    const listeners = new Set<() => void>();
    const ages = new Map([...mirror.keys()].map((k) => [k, 0]));
    let age = 0;
    const notify = () => {
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch {
          /* One consumer cannot interrupt a storage fence or another listener. */
        }
      }
    };
    const fail = () => {
      if (!healthy) return;
      healthy = false;
      if (!closed) notify();
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
        snapshot.clear();
        fail();
        return false;
      }
      inFlightMaps.add(snapshot);
      dirty = false;
      writing = exclusive(async () => {
        try {
          if (closed || !healthy) return false;
          let plain: string | undefined = JSON.stringify({
            v: 1,
            revision: String(next),
            entries: [...snapshot].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
          });
          parseSnapshot(plain, root, next).clear();
          const encryption = ports.encrypt(plain, root.key!, aad(root, next));
          plain = undefined; // The SDK may retain its argument; the writer no longer owns it across await.
          const ciphertext = await encryption;
          if (closed || !healthy || ciphertext.length > 710000) throw unavailable();
          await transaction(
            async (value) => {
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
            },
            () => !closed && healthy,
          );
          if (closed) return false;
          revision = next;
          committed.clear();
          for (const [key, value] of snapshot) committed.set(key, value);
          return true;
        } catch {
          fail();
          return false;
        } finally {
          snapshot.clear();
          inFlightMaps.delete(snapshot);
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
    async function flushMembership(membership: Map<string, string | undefined>): Promise<boolean> {
      inFlightMaps.add(membership);
      try {
        if (!(await write()) || closed || !healthy) return false;
        for (const [full, value] of membership) {
          if (
            !full.startsWith(prefix) ||
            committed.get(full.slice(prefix.length)) !== value ||
            mirror.get(full.slice(prefix.length)) !== value
          )
            return false;
        }
        return true;
      } catch {
        fail();
        return false;
      } finally {
        membership.clear();
        inFlightMaps.delete(membership);
      }
    }
    const port: StorageDurability = {
      flush(expected) {
        if (closed || !healthy) return Promise.resolve(false);
        // The synchronous frame releases the caller record; only the tracked map crosses await.
        return flushMembership(new Map(Object.entries(expected)));
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
        if (closed) return;
        closed = true;
        mirror.clear();
        ephemeral.clear();
        committed.clear();
        ages.clear();
        for (const pending of inFlightMaps) pending.clear();
        inFlightMaps.clear();
        delete root.key;
        dirty = false;
        // Release owned references only. JS strings, SDK arguments/native buffers and GC are not securely erased.
        notify();
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
  async function prepareOwner(
    owner: Preparation,
    ticket: number,
    identity: { origin: string; accountId: string; privacyEpoch: number },
    current: () => boolean,
  ): Promise<KeyValueStore> {
    const live = () => !owner.fenced && ticket === incarnation && current() && !owner.fenced && ticket === incarnation;
    // Result locals end with this helper. Only registered, clearable owners survive the next await.
    const retain = async <T>(operation: () => Promise<T>, accept: (value: T) => void) => {
      if (!live()) throw unavailable();
      const value = await operation();
      if (!live()) throw unavailable();
      accept(value);
    };
    try {
      await exclusive(async () => {
        if (
          !live() ||
          !owner.secrets.get('credential') ||
          !uuid.test(identity.accountId) ||
          new URL(identity.origin).origin !== identity.origin
        )
          throw unavailable();
        await retain(
          () => {
            const binding = ports.binding(owner.secrets.get('credential')!);
            owner.secrets.delete('credential');
            return binding;
          },
          (value) => {
            owner.binding = value;
          },
        );
        await retain(
          () => ports.readRoot(),
          (value) => {
            owner.emptyRoot = value === null;
            if (value !== null) owner.secrets.set('raw', value);
          },
        );
        if (!live()) throw unavailable();
        if (!owner.emptyRoot) owner.root = parseRoot(owner.secrets.get('raw')!);
        owner.secrets.delete('raw');
        const value = await database(live);
        if (!live()) throw unavailable();
        await retain(
          () => value.getFirstAsync<Row>('SELECT root_id,revision,body FROM ks_scoped_snapshot WHERE singleton=1'),
          (row) => {
            if (row) owner.row = row;
          },
        );
        if (!live()) throw unavailable();
        const same =
          owner.root?.origin === identity.origin &&
          owner.root.accountId === identity.accountId &&
          owner.root.privacyEpoch === identity.privacyEpoch &&
          owner.root.sessionBinding === owner.binding;
        if (owner.root?.status === 'open') {
          // No prior-commit witness exists: missing means unknown, NEVER empty initialization.
          if (!owner.row) throw unavailable();
          if (!same) {
            await close(owner.root.rootId);
            if (!live()) throw unavailable();
            delete owner.root.key;
            delete owner.root;
          } else {
            if (
              owner.row.root_id !== owner.root.rootId ||
              !Number.isSafeInteger(owner.row.revision) ||
              owner.row.revision < 1 ||
              owner.row.body.length > 710000
            )
              throw unavailable();
            await retain(
              () => ports.decrypt(owner.row!.body, owner.root!.key!, aad(owner.root!, owner.row!.revision)),
              (plain) => {
                owner.secrets.set('plaintext', plain);
              },
            );
            if (!live()) throw unavailable();
            const entries = parseSnapshot(owner.secrets.get('plaintext')!, owner.root, owner.row.revision);
            owner.secrets.delete('plaintext');
            if (!live()) {
              entries.clear();
              throw unavailable();
            }
            owner.entries = entries;
            owner.opened = makeRuntime(owner.root, owner.entries, owner.row.revision);
            owner.rootId = owner.root.rootId;
            delete owner.root;
            delete owner.entries;
            delete owner.row;
            return;
          }
        } else {
          if (
            same ||
            (owner.emptyRoot && owner.row) ||
            (owner.root && owner.row && owner.row.root_id !== owner.root.rootId)
          )
            throw unavailable();
          if (owner.root) {
            await close(owner.root.rootId);
            if (!live()) throw unavailable();
            delete owner.root;
          }
        }
        delete owner.row;
        await retain(
          () => ports.key(),
          (key) => {
            owner.secrets.set('key', key);
          },
        );
        await retain(
          () => ports.id(),
          (id) => {
            owner.rootId = id;
          },
        );
        if (!live()) throw unavailable();
        owner.root = {
          v: 1,
          status: 'open',
          origin: identity.origin,
          accountId: identity.accountId,
          privacyEpoch: identity.privacyEpoch,
          rootId: owner.rootId!,
          sessionBinding: owner.binding!,
          key: owner.secrets.get('key')!,
        };
        owner.secrets.delete('key');
        parseRoot(JSON.stringify(owner.root));
        // An entered native OPEN write cannot be cancelled. Cleanup remains queued behind it.
        await retain(
          () => ports.writeRoot(JSON.stringify(owner.root)),
          () => undefined,
        );
        if (!live()) throw unavailable();
        owner.entries = new Map();
        owner.opened = makeRuntime(owner.root, owner.entries, 0);
        delete owner.root;
        delete owner.entries;
      });
      if (!live()) {
        release(owner);
        if (owner.rootId) await exclusive(() => close(owner.rootId));
        throw unavailable();
      }
      const opened = owner.opened!;
      // Keep opened registered until initial flush/publication finishes; fence sees either owner.
      runtime = opened;
      if (!(await opened.port.flush({})) || !live()) throw unavailable();
      delete owner.opened; // Synchronous live ownership transfer, with no promise handoff gap.
      return opened.store;
    } finally {
      release(owner);
      preparing.delete(owner);
    }
  }
  return {
    fence() {
      incarnation++;
      releasePreparing();
      runtime?.port.fence();
    },
    purge() {
      incarnation++;
      releasePreparing();
      runtime?.port.fence();
      return exclusive(() => close());
    },
    prepare(input, current) {
      const ticket = ++incarnation;
      releasePreparing();
      const owner: Preparation = { fenced: false, secrets: new Map([['credential', input.credential]]) };
      preparing.add(owner); // Before any async credential/key/root/plaintext acquisition.
      return prepareOwner(
        owner,
        ticket,
        {
          origin: input.origin,
          accountId: input.account.accountId,
          privacyEpoch: input.account.privacyEpoch,
        },
        current,
      );
    },
  };
}
