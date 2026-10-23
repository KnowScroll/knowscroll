/** ks-native-durability-bootstrap-v1: private synthetic CI HTTP; never a real-service/auth receipt. */
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Linking from 'expo-linking';
import * as SecureStore from 'expo-secure-store';
import * as SQLite from 'expo-sqlite';
import * as Crypto from 'expo-crypto';
import {
  createAccountScopeManager,
  createScopedBlockStateStore,
  scopeOutbox,
  type AccountScope,
  type AccountScopeManager,
} from '@knowscroll/client-core';
import {
  ReadRecordingPolicySchema,
  RecordingPolicyReadSchema,
  RecordingPolicyAcceptanceSchema,
  SetRecordingPolicySchema,
  RecordingObservationBatchRequestSchema,
  RecordingObservationBatchResponseSchema,
  SessionResponseSchema,
  RedeemSignInResponseSchema,
  RedeemSignInSchema,
} from '@knowscroll/contracts';
import { sessionTokens } from '../../platform/session-tokens';
import { scopeDurability, scopeStorage } from '../../platform/scope-storage';
import { newCommandId } from '../../platform/command-id';
import { writeResume, readResume } from '../encounter/encounter-history';
import { createAnchorKeeper } from '../scroll/anchor-keeper';

const ORIGIN = 'https://native249.fixture.invalid';
const SCENARIO = 'native249-v1';
const ROOT = 'ks.scope.root.v1',
  SERVICE = 'ks.scoped-durability.v1';
const TOKEN = `kss_${'a'.repeat(43)}`,
  NEXT_TOKEN = `kss_${'b'.repeat(43)}`;
const LINK = `ksl_${'c'.repeat(43)}`;
const id = (n: number) => `0199a249-0000-7000-8000-${String(n).padStart(12, '0')}`;
const account = { accountId: id(1), universeId: id(2), privacyEpoch: 1, email: 'native249@fixture.invalid' };
const policyCommand = {
  version: 'recording-policy.v1' as const,
  commandId: id(3),
  expectedPrivacyEpoch: 1,
  expectedRecordingGeneration: 1,
  on: false,
};
const event = {
  schemaVersion: 'interaction.v1' as const,
  eventId: id(4),
  sessionId: id(5),
  exposureId: id(6),
  assetId: id(7),
  assetRevision: 5,
  occurredAt: '2026-10-23T00:00:00.000Z',
  deviceSequence: 1,
  kind: 'scroll.active_dwell' as const,
  payload: { activeIntervalsMs: [[0, 100]] },
};
const batch = RecordingObservationBatchRequestSchema.parse({
  version: 'observation-batch.v2',
  recordingGeneration: 1,
  instrumentationVersion: 1,
  events: [event],
});
const stateKey = `scroll.block.${id(7)}.5.panel-open`,
  indexKey = `scroll.block.index.${id(7)}.panel-open`;
const anchorKey = `scroll.anchor.${id(7)}.5`,
  resumeKey = `encounter.resume.${id(7)}.5`;
const stateRaw = JSON.stringify({ type: 'disclosure', expanded: true });
const resumeRaw = JSON.stringify({
  kind: 'scroll',
  value: { assetId: id(7), revision: 5, blockId: 'panel-open', offsetWithinBlock: 0.25 },
});
function demand(yes: unknown): asserts yes {
  if (!yes) throw new Error('NATIVE249_ASSERTION');
}
const response = (value: unknown) =>
  new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export type NativeMode = 'seed' | 'restore' | 'sqlite-denied';
export type NativeReceipt = Readonly<{
  phase:
    | 'starting'
    | 'seed-ready'
    | 'restored-ready'
    | 'acked-ready'
    | 'sqlite-unavailable'
    | 'secure-failed-commit'
    | 'complete'
    | 'failed';
  checks: number;
  fixtureRequests: number;
}>;
async function bounded<T>(work: Promise<T>, ms = 20000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('NATIVE249_TIMEOUT')), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
async function until(test: () => boolean) {
  const end = Date.now() + 15000;
  while (!test()) {
    if (Date.now() >= end) throw new Error('NATIVE249_TIMEOUT');
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}
async function rootMetadata() {
  const raw = await SecureStore.getItemAsync(ROOT, { keychainService: SERVICE });
  if (raw === null) return undefined;
  const value: unknown = JSON.parse(raw);
  demand(
    typeof value === 'object' &&
      value !== null &&
      'v' in value &&
      value.v === 1 &&
      'status' in value &&
      (value.status === 'open' || value.status === 'closed') &&
      'origin' in value &&
      value.origin === ORIGIN &&
      'accountId' in value &&
      value.accountId === account.accountId &&
      'privacyEpoch' in value &&
      value.privacyEpoch === 1 &&
      'rootId' in value &&
      typeof value.rootId === 'string' &&
      'sessionBinding' in value &&
      typeof value.sessionBinding === 'string',
  );
  const hasKey = 'key' in value;
  demand(value.status === 'open' ? hasKey : !hasKey);
  return { status: value.status, rootId: value.rootId, sessionBinding: value.sessionBinding, hasKey };
}
async function binding(token: string) {
  const encoder = new TextEncoder(),
    parts = ['ks.native.scoped-session.v1', token].map((s) => encoder.encode(s));
  const bytes = new Uint8Array(parts.reduce((n, p) => n + 4 + p.length, 0));
  let at = 0;
  for (const part of parts) {
    new DataView(bytes.buffer).setUint32(at, part.length, false);
    at += 4;
    bytes.set(part, at);
    at += part.length;
  }
  return [...new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes))]
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('');
}
async function rowCount() {
  const database = await SQLite.openDatabaseAsync('ks-scoped-v1.db', { useNewConnection: true });
  try {
    return (await database.getFirstAsync<{ n: number }>('SELECT count(*) AS n FROM ks_scoped_snapshot'))?.n;
  } finally {
    await database.closeAsync();
  }
}

export interface NativeDurabilityHarness {
  readonly manager: AccountScopeManager;
  readonly mode: NativeMode;
  readonly subscribe: (listener: () => void) => () => void;
  readonly getState: () => NativeReceipt;
  mounted(scope: AccountScope): Promise<void>;
  sqliteUnavailable(): Promise<void>;
  completePending(scope: AccountScope): Promise<void>;
  failClosed(scope: AccountScope): Promise<void>;
  retryCleanup(): Promise<void>;
}
export type NativeBootstrap =
  | {
      readonly kind: 'ready';
      readonly marker: 'ks-native-durability-bootstrap-v1';
      readonly harness: NativeDurabilityHarness;
    }
  | { readonly kind: 'unavailable' };
let startup: Promise<NativeBootstrap> | undefined;

async function makeHarness(): Promise<NativeBootstrap> {
  demand(
    Platform.OS === 'android' &&
      process.env.EXPO_PUBLIC_KS_GALLERY === '1' &&
      process.env.EXPO_PUBLIC_KS_NATIVE_DURABILITY_CI === '1' &&
      process.env.EXPO_PUBLIC_KS_API_ORIGIN === ORIGIN &&
      Constants.expoConfig?.android?.package === 'com.knowscroll.client',
  );
  const link = await bounded(Linking.getInitialURL(), 5000);
  demand(link !== null);
  // React Native's installed URL hostname/path parser only handles HTTP(S). Accept only the
  // three complete authored custom-scheme links; no permissive parsing/default mode may seed.
  const mode = (['seed', 'restore', 'sqlite-denied'] as const).find(
    (candidate) => link === `knowscroll://gallery-durability?scenario=${SCENARIO}&mode=${candidate}`,
  );
  demand(mode !== undefined);
  demand(sessionTokens !== undefined && scopeDurability !== undefined);
  const tokens = sessionTokens;
  const token = await tokens.read(),
    before = await rootMetadata();
  if (mode === 'seed') {
    demand(token === undefined && before === undefined);
    await tokens.write(TOKEN);
  } else {
    demand(
      token === TOKEN && before?.status === 'open' && before.hasKey && before.sessionBinding === (await binding(TOKEN)),
    );
  }
  let initialRoot = before?.rootId;
  let receipt: NativeReceipt = { phase: 'starting', checks: 0, fixtureRequests: 0 };
  const listeners = new Set<() => void>();
  const publish = (phase: NativeReceipt['phase'], checks = receipt.checks) => {
    receipt = { phase, checks, fixtureRequests: requests };
    for (const listener of [...listeners]) listener();
  };
  let requests = 0,
    unexpected = 0,
    generation = 1,
    activeToken = TOKEN,
    allowCurrent = false,
    allowBatch = false,
    allowPolicy = false;
  const currentWaiters = new Set<() => void>(),
    batchWaiters = new Set<() => void>();
  const releaseCurrent = () => {
    allowCurrent = true;
    for (const release of [...currentWaiters]) release();
    currentWaiters.clear();
  };
  const hold = (waiters: Set<() => void>, signal: AbortSignal) =>
    bounded(
      new Promise<void>((resolve, reject) => {
        const abort = () => {
          waiters.delete(release);
          reject(new Error('NATIVE249_SYNTHETIC_ABORT'));
        };
        const release = () => {
          signal.removeEventListener('abort', abort);
          waiters.delete(release);
          resolve();
        };
        waiters.add(release);
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      }),
      180000,
    );
  const fixtureFetch = async (request: Request): Promise<Response> => {
    requests++;
    const target = new URL(request.url),
      authorization = request.headers.get('authorization');
    try {
      demand(target.origin === ORIGIN && target.search === '');
      demand(
        authorization === `Bearer ${activeToken}` ||
          ((target.pathname === '/auth/sign-out' ||
            (target.pathname === '/auth/redeem' && receipt.phase === 'secure-failed-commit')) &&
            authorization === null),
      );
      if (request.method === 'GET' && target.pathname === '/auth/session')
        return response(
          SessionResponseSchema.parse({ account, client: 'native', expiresAt: '2099-10-23T00:00:00.000Z' }),
        );
      if (request.method === 'POST' && target.pathname === '/auth/sign-out') {
        demand(same(await request.json(), { everywhere: false }));
        return response({});
      }
      if (request.method === 'POST' && target.pathname === '/auth/redeem') {
        const body = RedeemSignInSchema.parse(await request.json());
        demand(
          body.token === LINK &&
            body.commandId === id(20) &&
            body.client === 'native' &&
            body.codeVerifier === undefined,
        );
        activeToken = NEXT_TOKEN;
        return response(
          RedeemSignInResponseSchema.parse({
            account,
            accountCreated: false,
            replayed: false,
            session: { kind: 'bearer', token: NEXT_TOKEN, expiresAt: '2099-10-23T00:00:00.000Z' },
          }),
        );
      }
      demand(request.method === 'POST' && request.headers.get('x-ks-scope') === `${account.accountId}:1`);
      if (target.pathname === '/v1/privacy/recording/read') {
        const body = ReadRecordingPolicySchema.parse(await request.json());
        demand(body.target.kind === 'current');
        if (!allowCurrent) await hold(currentWaiters, request.signal);
        return response(
          RecordingPolicyReadSchema.parse({
            ...body,
            scope: { accountId: account.accountId, privacyEpoch: 1 },
            revision: generation,
            policy: { on: generation % 2 === 1, generation },
          }),
        );
      }
      if (target.pathname === '/v1/privacy/recording/set') {
        const body = SetRecordingPolicySchema.parse(await request.json());
        if (body.commandId === policyCommand.commandId) {
          demand(same(body, SetRecordingPolicySchema.parse(policyCommand)));
          if (!allowPolicy) throw new Error('NATIVE249_SYNTHETIC_UNKNOWN');
          generation = 2;
        } else {
          demand(
            allowPolicy &&
              generation === 2 &&
              body.expectedPrivacyEpoch === 1 &&
              body.expectedRecordingGeneration === 2 &&
              body.on,
          );
          generation = 3;
        }
        allowCurrent = false;
        return response(
          RecordingPolicyAcceptanceSchema.parse({
            version: 'recording-policy.v1',
            operation: 'privacy.recording-set',
            outcome: 'accepted',
            replayed: false,
            receipt: {
              commandId: body.commandId,
              requestedPrivacyEpoch: 1,
              on: body.on,
              fromGeneration: body.expectedRecordingGeneration,
              toGeneration: generation,
              changed: true,
              recordedAt: '2026-10-23T00:00:00.000Z',
            },
          }),
        );
      }
      if (target.pathname === '/v1/observations/recording-batch') {
        const body = RecordingObservationBatchRequestSchema.parse(await request.json());
        demand(same(body, batch));
        if (!allowBatch) await hold(batchWaiters, request.signal);
        demand(generation === 1);
        return response(
          RecordingObservationBatchResponseSchema.parse({
            version: 'observation-batch.v2',
            recordingGeneration: 1,
            currentGeneration: 1,
            scope: { accountId: account.accountId, privacyEpoch: 1 },
            revision: 1,
            result: 'processed',
            accepted: 1,
            duplicates: 0,
            rejected: 0,
            results: [{ eventId: id(4), status: 'accepted' }],
          }),
        );
      }
      throw new Error('NATIVE249_UNEXPECTED_PATH');
    } catch (error) {
      if (!(error instanceof Error && error.message === 'NATIVE249_SYNTHETIC_UNKNOWN') && !request.signal.aborted)
        unexpected++;
      // eslint-disable-next-line preserve-caught-error -- Strip private request/schema details at the fixture boundary; never retain raw causes.
      throw new Error('NATIVE249_FIXTURE_REFUSAL');
    }
  };
  const manager = createAccountScopeManager({
    baseUrl: ORIGIN,
    platform: 'native',
    tokens,
    store: scopeStorage,
    durableStorage: scopeDurability,
    fetch: fixtureFetch,
  });
  const mounted = new WeakSet<AccountScope>();
  let busy = false;
  const guard = async (work: () => Promise<void>) => {
    if (busy) return;
    busy = true;
    try {
      await bounded(work(), 60000);
    } catch {
      publish('failed');
    } finally {
      busy = false;
    }
  };
  const witness = async (scope: AccountScope) => {
    demand(
      scope.active &&
        scope.account.accountId === account.accountId &&
        scope.account.privacyEpoch === 1 &&
        !scope.recording?.getState().collecting,
    );
    demand(
      same(
        SetRecordingPolicySchema.parse(JSON.parse(scope.storage.get('recording.policy.pending.v1') ?? 'null')),
        policyCommand,
      ),
    );
    const queued: unknown = JSON.parse(scope.storage.get('recorder.outbox.v2') ?? 'null');
    demand(
      typeof queued === 'object' &&
        queued !== null &&
        'v' in queued &&
        queued.v === 2 &&
        'batches' in queued &&
        Array.isArray(queued.batches) &&
        queued.batches.length === 1 &&
        same(RecordingObservationBatchRequestSchema.parse(queued.batches[0]), batch) &&
        'dropped' in queued &&
        queued.dropped === 0 &&
        'legacyDiscarded' in queued &&
        queued.legacyDiscarded === false &&
        Object.keys(queued).sort().join(',') === 'batches,dropped,legacyDiscarded,v',
    );
    const expected = {
      'recording.policy.pending.v1': JSON.stringify(policyCommand),
      'recorder.outbox.v2': scope.storage.get('recorder.outbox.v2'),
      ...Object.fromEntries([2, 3, 4, 5].map((revision) => [`scroll.block.${id(7)}.${revision}.panel-open`, stateRaw])),
      [stateKey]: stateRaw,
      [`scroll.block.${id(7)}.1.panel-open`]: undefined,
      [indexKey]: '[2,3,4,5]',
      [anchorKey]: 'panel-open',
      [resumeKey]: resumeRaw,
    };
    demand(
      scope.storage.get(stateKey) === stateRaw &&
        scope.storage.get(indexKey) === '[2,3,4,5]' &&
        scope.storage.get(`scroll.block.${id(7)}.1.panel-open`) === undefined &&
        scope.storage.get(anchorKey) === 'panel-open' &&
        scope.storage.get(resumeKey) === resumeRaw,
    );
    for (const [key, value] of Object.entries(expected)) demand(scope.storage.get(key) === value);
    demand(readResume(scope, id(7), 5)?.kind === 'scroll');
    demand(await scope.storage.durability?.flush(expected));
    const root = await rootMetadata();
    demand(root?.status === 'open' && root.hasKey && root.sessionBinding === (await binding(TOKEN)));
    if (initialRoot !== undefined) demand(root.rootId === initialRoot);
    else initialRoot = root.rootId;
    demand(unexpected === 0);
  };
  const harness: NativeDurabilityHarness = {
    manager,
    mode,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getState: () => receipt,
    mounted(scope) {
      return guard(async () => {
        if (mounted.has(scope)) return;
        mounted.add(scope);
        if (mode === 'seed') {
          releaseCurrent();
          demand(await scope.recording?.refresh());
          demand(scope.recording?.getState().collecting);
          const blocks = createScopedBlockStateStore(scope.storage);
          scope.storage.durability!.group(() => {
            for (let revision = 1; revision <= 5; revision++)
              blocks.set({ assetId: id(7), revision, blockId: 'panel-open' }, { type: 'disclosure', expanded: true });
            createAnchorKeeper({
              assetId: id(7),
              revision: 5,
              order: ['panel-open'],
              storage: scope.storage,
            }).observer.onBlockVisibility({ blockId: 'panel-open', visibleFraction: 1, at: 0 });
            writeResume(scope, id(7), 5, {
              kind: 'scroll',
              value: { assetId: id(7), revision: 5, blockId: 'panel-open', offsetWithinBlock: 0.25 },
            });
          });
          scopeOutbox(scope).enqueue(batch.events, 1, 1);
          scope.recording.useIdSource(() => policyCommand.commandId);
          const sending = scope.recording.set(false);
          scope.recording.useIdSource(newCommandId);
          demand(!(await sending));
          allowCurrent = false;
          await witness(scope);
          publish('seed-ready', 8);
        } else {
          demand(mode === 'restore');
          await witness(scope);
          publish('restored-ready', 8);
        }
      });
    },
    sqliteUnavailable() {
      return guard(async () => {
        demand(
          mode === 'sqlite-denied' && manager.getState().status === 'unavailable' && (await tokens.read()) === TOKEN,
        );
        const root = await rootMetadata();
        demand(root !== undefined && root.rootId === initialRoot && root.status === 'open');
        let rejected = false;
        try {
          const database = await SQLite.openDatabaseAsync('ks-scoped-v1.db', { useNewConnection: true });
          try {
            await database.getFirstAsync('PRAGMA journal_mode');
          } finally {
            await database.closeAsync();
          }
        } catch (error) {
          rejected =
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            (error.code === 'ERR_OPEN_DATABASE' || error.code === 'ERR_INTERNAL_SQLITE_ERROR');
        }
        demand(rejected);
        publish('sqlite-unavailable', 3);
      });
    },
    completePending(scope) {
      return guard(async () => {
        demand(receipt.phase === 'restored-ready');
        await witness(scope);
        allowBatch = true;
        for (const release of [...batchWaiters]) release();
        batchWaiters.clear();
        await until(() => scopeOutbox(scope).status().pendingBatches === 0);
        demand(await scope.storage.durability?.flush({ 'recorder.outbox.v2': undefined }));
        allowPolicy = true;
        const retry = scope.recording!.retryOriginal();
        await until(() => scope.recording!.getState().receipt?.commandId === policyCommand.commandId);
        demand(
          !scope.recording!.getState().collecting &&
            (await scope.storage.durability?.flush({ 'recording.policy.pending.v1': undefined })),
        );
        releaseCurrent();
        demand(await retry);
        demand(scope.recording!.getState().policy?.generation === 2 && !scope.recording!.getState().collecting);
        const resume = scope.recording!.set(true);
        await until(() => scope.recording!.getState().receipt?.toGeneration === 3);
        demand(!scope.recording!.getState().collecting);
        releaseCurrent();
        demand(await resume);
        demand(scope.recording!.getState().collecting && unexpected === 0);
        publish('acked-ready', 7);
      });
    },
    failClosed(scope) {
      return guard(async () => {
        demand(receipt.phase === 'acked-ready');
        scope.end();
        let branch = false;
        try {
          await scope.whenStorageClosed?.();
        } catch (error) {
          branch =
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 'ERR_WRITE' &&
            'message' in error &&
            typeof error.message === 'string' &&
            error.message.includes('Could not commit encrypted value to SecureStore');
        }
        demand(branch && (await rowCount()) === 1 && (await tokens.read()) === TOKEN);
        demand(
          (await manager.signOut()) === 'unavailable' &&
            manager.getState().status === 'unavailable' &&
            (await rowCount()) === 1,
        );
        publish('secure-failed-commit', 4);
      });
    },
    retryCleanup() {
      return guard(async () => {
        demand(receipt.phase === 'secure-failed-commit');
        demand((await manager.signOut()) === 'signed_out');
        const closed = await rootMetadata();
        demand(
          closed?.status === 'closed' &&
            !closed.hasKey &&
            (await rowCount()) === 0 &&
            (await tokens.read()) === undefined,
        );
        let refused = false;
        try {
          await scopeDurability.prepare({ account, origin: ORIGIN, credential: TOKEN }, () => true);
        } catch {
          refused = true;
        }
        demand(refused);
        allowCurrent = false;
        demand((await manager.redeem({ token: LINK, commandId: id(20) })).kind === 'signed_in');
        const state = manager.getState();
        demand(state.status === 'signed_in' && !state.scope.recording?.getState().collecting);
        const changed = await rootMetadata();
        demand(
          changed?.status === 'open' &&
            changed.rootId !== initialRoot &&
            changed.sessionBinding === (await binding(NEXT_TOKEN)),
        );
        demand(
          (await manager.signOut()) === 'signed_out' && (await rowCount()) === 0 && (await tokens.read()) === undefined,
        );
        demand(unexpected === 0);
        publish('complete', 8);
      });
    },
  };
  return { kind: 'ready', marker: 'ks-native-durability-bootstrap-v1', harness };
}
export function nativeDurabilityBootstrap(): Promise<NativeBootstrap> {
  startup ??= makeHarness().catch(() => ({ kind: 'unavailable' as const }));
  return startup;
}
