import { QueryClient, useQuery } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react-native';
import { AppState, Platform, Text, type AppStateStatus } from 'react-native';
import {
  createAccountScopeManager,
  memoryStore,
  type AccountScope,
  type StorageDurability,
  type ScopeStorageLifecycle,
} from '@knowscroll/client-core';
import { AccountScopeProvider, useAccountScope } from './account-scope';

/**
 * The AccountScope provider (blueprint §18) over a labelled fixture `fetch` (no network, no API):
 * an account switch must stop the old scope before the new one mounts, and an answer the old
 * scope asked for that arrives afterwards must never appear in the new scope. Accounts and
 * addresses are fixtures.
 */
const accounts = {
  a: {
    accountId: '0199a000-0000-7000-8000-00000000000a',
    universeId: '0199a000-0000-7000-8000-0000000000aa',
    privacyEpoch: 1,
    email: 'a@scope.test',
  },
  b: {
    accountId: '0199b000-0000-7000-8000-00000000000b',
    universeId: '0199b000-0000-7000-8000-0000000000bb',
    privacyEpoch: 1,
    email: 'b@scope.test',
  },
};

/** No garbage-collection timers outlive a test (TanStack's 5-minute `gcTime` would). */
const newQueryClient = () => new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } });

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** The fixture server: the session is A until B's link is redeemed; `/v1/saved` waits for the test. */
function fixtureServer() {
  let current: typeof accounts.a = accounts.a;
  const saved: { release: (revision: number) => void; aborted: boolean }[] = [];
  const fetch = jest.fn((request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    // Explicit current-policy HTTP fixture; independent of the encounter/Keep command log.
    if (path === '/v1/privacy/recording/read')
      return request
        .clone()
        .json()
        .then((input: { readId: string; target: unknown }) => {
          const claim = request.headers.get('x-ks-scope')!.split(':');
          return new Response(
            JSON.stringify({
              version: 'recording-policy.v1',
              ...input,
              scope: { accountId: claim[0], privacyEpoch: Number(claim[1]) },
              revision: 0,
              policy: { on: true, generation: 1 },
            }),
            { headers: { 'content-type': 'application/json' } },
          );
        });
    if (path === '/auth/session')
      return Promise.resolve(json(200, { account: current, client: 'web', expiresAt: '2026-11-18T00:00:00.000Z' }));
    if (path === '/auth/redeem') {
      current = accounts.b;
      return Promise.resolve(
        json(200, {
          account: current,
          accountCreated: false,
          replayed: false,
          session: { kind: 'cookie', expiresAt: '2026-11-18T00:00:00.000Z' },
        }),
      );
    }
    if (path === '/v1/saved')
      return new Promise((resolve, reject) => {
        const entry = { release: (revision: number) => resolve(json(200, { revision, items: [] })), aborted: false };
        request.signal.addEventListener('abort', () => {
          entry.aborted = true;
          reject(new Error('aborted'));
        });
        saved.push(entry);
      });
    return Promise.resolve(json(404, {}));
  });
  return { fetch, saved };
}

function Saved({ scope }: { readonly scope: AccountScope }) {
  const query = useQuery({
    queryKey: scope.queryKey('saved'),
    queryFn: () => scope.api.experience.listSaved({}),
    retry: false,
  });
  return (
    <Text>{`${scope.account.email}: ${query.data === undefined ? 'loading' : `revision ${query.data.revision}`}`}</Text>
  );
}

function SavedOfCurrentScope() {
  const { state } = useAccountScope();
  return state.status === 'signed_in' ? <Saved scope={state.scope} /> : <Text>signed out</Text>;
}

describe('AccountScopeProvider', () => {
  it('fences a late answer for the old account: it never reaches the new scope after a switch', async () => {
    const server = fixtureServer();
    const manager = createAccountScopeManager({
      baseUrl: 'https://app.scope.test',
      platform: 'web',
      fetch: server.fetch,
      store: memoryStore(),
      newQueryClient,
    });
    await render(
      <AccountScopeProvider manager={manager}>
        <SavedOfCurrentScope />
      </AccountScopeProvider>,
    );
    expect(await screen.findByText('a@scope.test: loading')).toBeOnTheScreen();
    const first = manager.getState();
    if (first.status !== 'signed_in') throw new Error('expected account A');
    const scopeA = first.scope;
    expect(server.saved).toHaveLength(1);

    // Switch accounts while A's read is still in flight.
    await act(async () => {
      await manager.redeem({ token: `ksl_${'b'.repeat(43)}`, commandId: '0199c000-0000-7000-8000-000000000001' });
    });
    expect(await screen.findByText('b@scope.test: loading')).toBeOnTheScreen();
    expect(scopeA.active).toBe(false);
    expect(server.saved[0]?.aborted).toBe(true);

    // A's answer arrives late; then B's own answer.
    await act(async () => {
      server.saved[0]?.release(41);
      await Promise.resolve();
    });
    await act(async () => {
      server.saved[1]?.release(3);
      await Promise.resolve();
    });

    expect(await screen.findByText('b@scope.test: revision 3')).toBeOnTheScreen();
    expect(screen.queryByText(/revision 41/)).toBeNull();
    const second = manager.getState();
    if (second.status !== 'signed_in') throw new Error('expected account B');
    const cached = second.scope.queryClient
      .getQueryCache()
      .getAll()
      .map((query) => ({ key: query.queryKey, data: query.state.data }));
    expect(cached).toEqual([{ key: second.scope.queryKey('saved'), data: { revision: 3, items: [] } }]);
    expect(scopeA.queryClient.getQueryCache().getAll()).toEqual([]);
  });

  it('renders the signed-out state once the session is known, and nothing before', async () => {
    const manager = createAccountScopeManager({
      baseUrl: 'https://app.scope.test',
      platform: 'web',
      fetch: () => Promise.resolve(json(401, {})),
      store: memoryStore(),
      newQueryClient,
    });
    await render(
      <AccountScopeProvider manager={manager}>
        <SavedOfCurrentScope />
      </AccountScopeProvider>,
    );
    expect(await screen.findByText('signed out')).toBeOnTheScreen();
    expect(manager.getState()).toEqual({ status: 'signed_out', reason: 'none' });
  });
});

it('native background inhibits recording and foreground rereads without remounting or resetting epoch (CI callbacks)', async () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(Platform, 'OS');
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
  // RN's window exists without these DOM methods. Exercise that actual platform distinction
  // in both hosted Jest projects while retaining the full background/reconnect/current-read flow.
  const nativeWindow = typeof window === 'undefined' ? undefined : window;
  const originalAdd = nativeWindow && Object.getOwnPropertyDescriptor(nativeWindow, 'addEventListener');
  const originalRemove = nativeWindow && Object.getOwnPropertyDescriptor(nativeWindow, 'removeEventListener');
  if (nativeWindow) {
    Object.defineProperty(nativeWindow, 'addEventListener', { configurable: true, value: undefined });
    Object.defineProperty(nativeWindow, 'removeEventListener', { configurable: true, value: undefined });
  }
  const original = Object.getOwnPropertyDescriptor(AppState, 'currentState');
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
  let change: ((state: AppStateStatus) => void) | undefined;
  const remove = jest.fn();
  const subscription = jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
    change = listener;
    return { remove };
  });
  let generation = 1;
  let wait: Promise<void> | undefined;
  const manager = createAccountScopeManager({
    baseUrl: 'https://lifecycle.fixture.test',
    platform: 'web',
    store: memoryStore(),
    newQueryClient,
    fetch: async (request) => {
      if (request.url.endsWith('/auth/session'))
        return json(200, { account: accounts.a, client: 'web', expiresAt: '2099-10-23T00:00:00.000Z' });
      const input = (await request.json()) as { readId: string; target: unknown };
      await wait;
      return json(200, {
        version: 'recording-policy.v1',
        ...input,
        scope: { accountId: accounts.a.accountId, privacyEpoch: 1 },
        revision: generation,
        policy: { on: generation % 2 === 1, generation },
      });
    },
  });
  let app: Awaited<ReturnType<typeof render>> | undefined;
  try {
    app = await render(
      <AccountScopeProvider manager={manager}>
        <Text>Lifecycle fixture</Text>
      </AccountScopeProvider>,
    );
    await waitFor(() => expect(manager.getState().status).toBe('signed_in'));
    const first = manager.getState();
    if (first.status !== 'signed_in') throw new Error('fixture sign-in');
    const scope = first.scope;
    await waitFor(() => expect(scope.recording!.getState().collecting).toBe(true));
    await act(() => {
      Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'background' });
      change?.('background');
    });
    expect(scope.recording!.getState().collecting).toBe(false);
    generation = 3;
    // Reconnect begins a NEW read after the background callback, not just an old fenced response.
    await act(() => {
      scope.reconnect();
    });
    await waitFor(() => expect(scope.recording!.getState().policy?.generation).toBe(3));
    expect(scope.recording!.getState().collecting).toBe(false);
    await act(async () => {
      await scope.recording!.refresh();
    });
    expect(scope.recording!.getState().collecting).toBe(false);
    let release!: () => void;
    wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    generation = 3;
    await act(() => {
      Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
      change?.('active');
    });
    expect(scope.recording!.getState().collecting).toBe(false);
    await act(() => {
      release();
    });
    await waitFor(() =>
      expect(scope.recording!.getState()).toMatchObject({ collecting: true, policy: { generation: 3 } }),
    );
    const current = manager.getState();
    expect(current.status === 'signed_in' && current.scope).toBe(scope);
    expect(scope.account.privacyEpoch).toBe(1);
  } finally {
    try {
      await app?.unmount();
    } finally {
      manager.dispose();
      subscription.mockRestore();
      if (original) Object.defineProperty(AppState, 'currentState', original);
      if (originalPlatform) Object.defineProperty(Platform, 'OS', originalPlatform);
      if (nativeWindow) {
        if (originalAdd) Object.defineProperty(nativeWindow, 'addEventListener', originalAdd);
        else Reflect.deleteProperty(nativeWindow, 'addEventListener');
        if (originalRemove) Object.defineProperty(nativeWindow, 'removeEventListener', originalRemove);
        else Reflect.deleteProperty(nativeWindow, 'removeEventListener');
      }
    }
  }
  expect(remove).toHaveBeenCalled();
});

it('publishes hydrated native scope before replaying its original backlog, without restoring collection authority (CI lifecycle ports)', async () => {
  const original = Object.getOwnPropertyDescriptor(AppState, 'currentState');
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
  const store = memoryStore(),
    disk = new Map<string, string>(),
    listeners = new Set<() => void>();
  const prefix = `ks.scope.${accounts.a.accountId}:1.`;
  const command = {
    version: 'recording-policy.v1',
    commandId: '0199a000-0000-7000-8000-000000000091',
    expectedPrivacyEpoch: 1,
    expectedRecordingGeneration: 3,
    on: false,
  };
  const event = {
    schemaVersion: 'interaction.v1',
    eventId: '0199a000-0000-7000-8000-000000000092',
    sessionId: '0199a000-0000-7000-8000-000000000093',
    deviceSequence: 8,
    exposureId: '0199a000-0000-7000-8000-000000000094',
    assetId: '0199a000-0000-7000-8000-000000000095',
    assetRevision: 1,
    kind: 'scroll.active_dwell',
    occurredAt: '2026-10-23T00:00:00.000Z',
    payload: { activeIntervalsMs: [[100, 200]] },
  };
  const batch = { version: 'observation-batch.v2', recordingGeneration: 3, instrumentationVersion: 1, events: [event] };
  let healthy = true;
  const durability: StorageDurability = {
    flush(expected) {
      if (!healthy) return Promise.resolve(false);
      disk.clear();
      for (const key of store.keys()) disk.set(key, store.getItem(key)!);
      return Promise.resolve(Object.entries(expected).every(([key, value]) => (disk.get(key) ?? undefined) === value));
    },
    group: (work) => work(),
    healthy: () => healthy,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    fence() {
      healthy = false;
      for (const listener of listeners) listener();
    },
    purge() {
      for (const key of store.keys()) store.removeItem(key);
      disk.clear();
      return Promise.resolve();
    },
  };
  let releaseHydration!: () => void;
  const hydration = new Promise<void>((resolve) => {
    releaseHydration = resolve;
  });
  const prepare = jest.fn(async () => {
    await hydration;
    store.setItem(prefix + 'recording.policy.pending.v1', JSON.stringify(command));
    store.setItem(
      prefix + 'recorder.outbox.v2',
      JSON.stringify({ v: 2, dropped: 0, legacyDiscarded: false, batches: [batch] }),
    );
    return { ...store, durability };
  });
  const lifecycle: ScopeStorageLifecycle = { prepare, fence: () => undefined, purge: () => durability.purge() };
  const sent: unknown[] = [],
    policyReads: unknown[] = [];
  const fetch = jest.fn(async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path === '/auth/session')
      return json(200, { account: accounts.a, client: 'native', expiresAt: '2099-10-23T00:00:00.000Z' });
    const body: unknown = await request.json();
    if (path === '/v1/observations/recording-batch') {
      sent.push(body);
      expect(disk.has(prefix + 'recorder.outbox.v2')).toBe(true);
      return json(200, {
        version: 'observation-batch.v2',
        scope: { accountId: accounts.a.accountId, privacyEpoch: 1 },
        recordingGeneration: 3,
        currentGeneration: 5,
        revision: 7,
        result: 'not_recorded',
        reason: 'recording_generation_stale',
      });
    }
    if (path === '/v1/saved') return json(200, { revision: 0, items: [] });
    if (path === '/v1/privacy/recording/read') {
      policyReads.push(body);
      return json(200, {
        version: 'recording-policy.v1',
        ...(body as object),
        scope: { accountId: accounts.a.accountId, privacyEpoch: 1 },
        revision: 7,
        policy: { on: true, generation: 5 },
      });
    }
    throw new Error('fixture must not activate or automatically resend policy');
  });
  const manager = createAccountScopeManager({
    baseUrl: 'https://native.fixture.test',
    platform: 'native',
    store: memoryStore(),
    tokens: {
      read: () => Promise.resolve('fixture-session'),
      write: () => Promise.resolve(),
      clear: () => Promise.resolve(),
    },
    durableStorage: lifecycle,
    fetch,
    newQueryClient,
  });
  const app = await render(
    <AccountScopeProvider manager={manager}>
      <SavedOfCurrentScope />
    </AccountScopeProvider>,
  );
  try {
    await waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
    expect(manager.getState()).toEqual({ status: 'starting' });
    expect(screen.queryByText('a@scope.test: loading')).toBeNull();
    expect(sent).toEqual([]);
    await act(() => {
      releaseHydration();
    });
    await waitFor(() => expect(sent).toEqual([batch]));
    await waitFor(() => expect(disk.has(prefix + 'recorder.outbox.v2')).toBe(false));
    const state = manager.getState();
    if (state.status !== 'signed_in') throw new Error('fixture hydrated scope');
    await waitFor(() => expect(state.scope.recording!.getState().policy?.generation).toBe(5));
    expect(state.scope.recording!.getState()).toMatchObject({
      collecting: false,
      retryOriginal: true,
      status: 'unknown',
    });
    expect(policyReads.length).toBeGreaterThan(0);
    expect(disk.get(prefix + 'recording.policy.pending.v1')).toBe(JSON.stringify(command));
    expect(fetch.mock.calls.some(([request]) => new URL(request.url).pathname === '/v1/privacy/recording/set')).toBe(
      false,
    );
    expect(sent).toHaveLength(1);
    expect(state.scope.account.privacyEpoch).toBe(1);
  } finally {
    await app.unmount();
    if (original) Object.defineProperty(AppState, 'currentState', original);
  }
});
