import { QueryClient } from '@tanstack/react-query';
import { Slot } from 'expo-router';
import { act, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import type { ReactNode } from 'react';
import { createAccountScopeManager, memoryStore, type KeyValueStore } from '@knowscroll/client-core';
import { DELETE_ACCOUNT_CONFIRMATION } from '@knowscroll/contracts';
import { DisplayProvider } from '@knowscroll/ui';
import { AccountScopeProvider } from '../../providers/account-scope';
import { WelcomeScreen } from '../auth/welcome-screen';
import { PrivacyClearScreen, PrivacyDeleteScreen, PrivacyExportScreen, PrivacyScreen } from '../privacy/privacy-screen';
import { AccountScreen } from './account-screen';

const mockOpenExportDownload = jest.fn<void, [string]>();
jest.mock('../../platform/export-download', () => ({
  openExportDownload: (path: string) => {
    mockOpenExportDownload(path);
  },
}));
let mockNextId = 0;
jest.mock('../../platform/command-id', () => ({
  newCommandId: () => `0199a000-0000-7000-8000-${String((mockNextId += 1)).padStart(12, '0')}`,
}));

const account = {
  accountId: '0199a000-0000-7000-8000-0000000000a1',
  universeId: '0199a000-0000-7000-8000-0000000000a2',
  privacyEpoch: 1,
  email: 'person@fixture.invalid',
};
const json = (value: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(value), { ...init, headers: { 'content-type': 'application/json' } });
const problem = (code: string, status: number) =>
  new Response(JSON.stringify({ type: 'tag:fixture', title: code, status, code }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

interface Fixture {
  sessions: { id: string; client: 'web' | 'native'; deviceLabel: string; lastUsedAt: string; current: boolean }[];
  exports: { id: string; state: string; requestedAt: string; expiresAt: string | null }[];
  deletionState: 'in_progress' | 'needs_retry' | 'completed' | 'unknown';
  deleteFails: boolean;
  /** The session read answers 401: nobody is signed in here. */
  signedOut: boolean;
}

/** Authored HTTP fixtures behind the real scope manager, provider, screens and router. */
async function mount(initialUrl: string, overrides: Partial<Fixture> = {}, store: KeyValueStore = memoryStore()) {
  const fixture: Fixture = {
    sessions: [
      { id: 's-here', client: 'web', deviceLabel: 'Chrome on macOS', lastUsedAt: minutesAgo(1), current: true },
      {
        id: 's-phone',
        client: 'native',
        deviceLabel: 'KnowScroll on iPhone',
        lastUsedAt: minutesAgo(3 * 24 * 60),
        current: false,
      },
    ],
    exports: [],
    deletionState: 'in_progress',
    deleteFails: false,
    signedOut: false,
    ...overrides,
  };
  const calls: { method: string; path: string; body: unknown; scope: string | null }[] = [];
  const manager = createAccountScopeManager({
    baseUrl: 'https://fixture.invalid',
    platform: 'web',
    store,
    newQueryClient: () => new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } }),
    fetch: async (request) => {
      const url = new URL(request.url);
      const body: unknown =
        request.method === 'POST'
          ? await request
              .clone()
              .json()
              .catch(() => undefined)
          : undefined;
      calls.push({ method: request.method, path: url.pathname, body, scope: request.headers.get('x-ks-scope') });
      const path = url.pathname;
      if (path === '/auth/session')
        return fixture.signedOut
          ? problem('UNAUTHENTICATED', 401)
          : json({ account, client: 'web', expiresAt: '2026-12-01T00:00:00.000Z' });
      if (path === '/v1/privacy/recording/read') {
        const input = body as { readId: string; target: unknown };
        return json({
          version: 'recording-policy.v1',
          ...input,
          scope: { accountId: account.accountId, privacyEpoch: 1 },
          revision: 0,
          policy: { on: true, generation: 1 },
        });
      }
      if (path === '/v1/privacy/clear-exploration/status')
        return json({
          version: 'clear-exploration.v1',
          scope: { accountId: account.accountId, privacyEpoch: 1 },
          target: (body as { target: unknown }).target,
          status: 'not_recorded',
        });
      if (path === '/v1/account/sessions')
        return json({
          sessions: fixture.sessions.map((session) => ({
            ...session,
            signedInAt: minutesAgo(10_000),
          })),
        });
      if (path === '/v1/account/sessions/end') {
        const { sessionId } = body as { sessionId: string };
        fixture.sessions = fixture.sessions.filter((session) => session.id !== sessionId);
        return json({ status: 'ended' });
      }
      if (path === '/v1/account/sessions/end-others') {
        fixture.sessions = fixture.sessions.filter((session) => session.current);
        return json({ revoked: 1 });
      }
      if (path === '/v1/account/exports' && request.method === 'GET') return json({ exports: fixture.exports });
      if (path === '/v1/account/exports' && request.method === 'POST') {
        const { exportId } = body as { exportId: string };
        fixture.exports = [{ id: exportId, state: 'preparing', requestedAt: minutesAgo(0), expiresAt: null }];
        return json({ export: fixture.exports[0] }, { status: 202 });
      }
      if (path === '/v1/account/exports/link')
        return json({ path: '/auth/exports/kse_secret-token', expiresAt: new Date(Date.now() + 60_000).toISOString() });
      if (path === '/v1/account/delete') {
        if (fixture.deleteFails) throw new Error('fixture offline');
        const input = body as { receiptId: string };
        return json({ receiptId: input.receiptId, requestedAt: minutesAgo(0) }, { status: 202 });
      }
      if (path.startsWith('/auth/deletion/'))
        return fixture.deletionState === 'unknown' ? problem('NOT_FOUND', 404) : json({ state: fixture.deletionState });
      return problem('NOT_FOUND', 404);
    },
  });
  const Layout = () => (
    <AccountScopeProvider manager={manager}>
      <Slot />
    </AccountScopeProvider>
  );
  const wrapper = ({ children }: { children: ReactNode }) => (
    <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>{children}</DisplayProvider>
  );
  const app = await renderRouter(
    {
      _layout: Layout,
      welcome: () => <WelcomeScreen />,
      account: () => <AccountScreen />,
      'account/privacy/index': () => <PrivacyScreen />,
      'account/privacy/export': () => <PrivacyExportScreen />,
      'account/privacy/clear': () => <PrivacyClearScreen />,
      'account/privacy/delete': () => <PrivacyDeleteScreen />,
    },
    { initialUrl, wrapper },
  );
  return { app, manager, fixture, calls, store };
}

beforeEach(() => {
  mockNextId = 0;
  mockOpenExportDownload.mockClear();
});

describe('P01 sessions', () => {
  it('shows where the person is signed in, marks this device and signs another out after one question', async () => {
    const f = await mount('/account');
    expect(await screen.findByText('Chrome on macOS')).toBeOnTheScreen();
    expect(screen.getByText('Signed in now')).toBeOnTheScreen();
    expect(screen.getByText('KnowScroll on iPhone')).toBeOnTheScreen();
    expect(screen.getByText('Last used 3 days ago')).toBeOnTheScreen();
    expect(screen.getByText('Current')).toBeOnTheScreen();
    // One question first: nothing is sent by the first tap.
    await fireEvent.press(screen.getByRole('button', { name: 'Sign out KnowScroll on iPhone' }));
    expect(screen.getByText('Sign out of KnowScroll on iPhone?')).toBeOnTheScreen();
    expect(f.calls.filter((call) => call.path === '/v1/account/sessions/end')).toHaveLength(0);
    await fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Sign out of KnowScroll on iPhone?')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Sign out KnowScroll on iPhone' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Confirm sign out of KnowScroll on iPhone' }));
    await waitFor(() => expect(screen.queryByText('KnowScroll on iPhone')).toBeNull());
    expect(f.calls.find((call) => call.path === '/v1/account/sessions/end')).toMatchObject({
      body: { sessionId: 's-phone' },
      scope: `${account.accountId}:1`,
    });
    expect(screen.getByText('Chrome on macOS')).toBeOnTheScreen();
    await f.app.unmount();
  });

  it('offers to sign out every other device only when there are several', async () => {
    const f = await mount('/account', {
      sessions: [
        { id: 's-here', client: 'web', deviceLabel: 'Chrome on macOS', lastUsedAt: minutesAgo(1), current: true },
        {
          id: 's-a',
          client: 'native',
          deviceLabel: 'KnowScroll on iPhone',
          lastUsedAt: minutesAgo(60),
          current: false,
        },
        { id: 's-b', client: 'web', deviceLabel: 'Edge on Windows', lastUsedAt: minutesAgo(600), current: false },
      ],
    });
    await fireEvent.press(await screen.findByRole('button', { name: 'Sign out of other devices' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Sign out 2 other devices' }));
    await waitFor(() => expect(screen.queryByText('Edge on Windows')).toBeNull());
    expect(f.calls.some((call) => call.path === '/v1/account/sessions/end-others')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Sign out of other devices' })).toBeNull();
    await f.app.unmount();
  });
});

describe('P02 hub and export', () => {
  it('lists what each control changes, one tap from its own page', async () => {
    const f = await mount('/account/privacy');
    for (const name of ['History & export', 'Clear exploration', 'Delete account'])
      expect(await screen.findByRole('link', { name })).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('link', { name: 'History & export' }));
    expect(f.app.getPathname()).toBe('/account/privacy/export');
    await f.app.unmount();
  });

  it('requests an export, shows it preparing, then ready, and downloads it once through a one-time link', async () => {
    jest.useFakeTimers({ advanceTimers: true });
    try {
      const f = await mount('/account/privacy/export');
      expect(await screen.findByText('No exports yet.')).toBeOnTheScreen();
      await fireEvent.press(screen.getByRole('button', { name: 'Request a new export' }));
      expect(await screen.findByText('Preparing')).toBeOnTheScreen();
      expect(screen.getByRole('button', { name: 'Request a new export' })).toBeDisabled();
      expect(f.calls.find((call) => call.method === 'POST' && call.path === '/v1/account/exports')?.body).toEqual({
        exportId: '0199a000-0000-7000-8000-000000000001',
      });

      // The worker finished: the next poll shows it ready.
      f.fixture.exports = [
        {
          id: '0199a000-0000-7000-8000-000000000001',
          state: 'ready',
          requestedAt: minutesAgo(1),
          expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        },
      ];
      await act(async () => {
        jest.advanceTimersByTime(4_500);
      });
      expect(await screen.findByText('Ready')).toBeOnTheScreen();
      await fireEvent.press(screen.getByRole('button', { name: 'Download' }));
      await waitFor(() => expect(mockOpenExportDownload).toHaveBeenCalledWith('/auth/exports/kse_secret-token'));
      expect(mockOpenExportDownload).toHaveBeenCalledTimes(1);
      // The link never reaches what is on the screen.
      expect(JSON.stringify(screen.toJSON())).not.toContain('kse_secret-token');

      f.fixture.exports = [{ ...f.fixture.exports[0]!, state: 'downloaded' }];
      await act(async () => {
        await f.manager.refresh();
      });
      await f.app.unmount();
    } finally {
      jest.useRealTimers();
    }
  });

  it('shows a failed export with a Retry that asks again', async () => {
    const f = await mount('/account/privacy/export', {
      exports: [
        {
          id: '0199a000-0000-7000-8000-0000000000e1',
          state: 'failed',
          requestedAt: minutesAgo(30),
          expiresAt: null,
        },
      ],
    });
    expect(await screen.findByText('Failed')).toBeOnTheScreen();
    expect(screen.getByText(/Nothing was sent anywhere/)).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Preparing')).toBeOnTheScreen();
    await f.app.unmount();
  });
});

describe('P02 delete account', () => {
  it('needs the acknowledgement, sends the confirmed request, signs out and shows the receipt', async () => {
    const f = await mount('/account/privacy/delete', { deletionState: 'in_progress' });
    const button = await screen.findByRole('button', { name: 'Delete account' });
    expect(button).toBeDisabled();
    expect(
      screen.getByText(/Removes your account, history, universe, kept items and messages you sent/),
    ).toBeOnTheScreen();
    expect(screen.getByText(/"Deleted account"/)).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('checkbox', { name: 'I understand this cannot be undone' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Delete account' }));

    // Signed out here, the receipt kept and shown on Account without any session.
    expect(await screen.findByText('Deletion in progress')).toBeOnTheScreen();
    expect(f.app.getPathname()).toBe('/account');
    const sent = f.calls.find((call) => call.path === '/v1/account/delete');
    expect(sent?.body).toEqual({
      receiptId: '0199a000-0000-7000-8000-000000000001',
      expectedPrivacyEpoch: 1,
      confirmation: DELETE_ACCOUNT_CONFIRMATION,
    });
    expect(f.manager.getState()).toEqual({ status: 'signed_out', reason: 'account_deleted' });
    expect(f.store.getItem('ks.deletion.receipt')).toBe('0199a000-0000-7000-8000-000000000001');
    expect(screen.getByText(/You're signed out everywhere/)).toBeOnTheScreen();
    expect(screen.getByText(/expire on their own schedule/)).toBeOnTheScreen();

    // Finished: gone from the live systems, with backups as their own line. Done clears the receipt.
    f.fixture.deletionState = 'completed';
    await act(async () => {
      await f.manager.deletion.refresh();
    });
    expect(await screen.findByText('Account deleted')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByText('Account deleted')).toBeNull();
    expect(f.store.getItem('ks.deletion.receipt')).toBeNull();
    expect(screen.getByText("You're not signed in")).toBeOnTheScreen();
    await f.app.unmount();
  });

  it('asks again from a failed receipt, on the sign-in page too', async () => {
    const store = memoryStore();
    store.setItem('ks.deletion.receipt', '0199a000-0000-7000-8000-0000000000d1');
    const f = await mount('/welcome', { deletionState: 'needs_retry', signedOut: true }, store);
    // No session: the receipt is read without one.
    expect(await screen.findByText("We couldn't finish removing")).toBeOnTheScreen();
    f.fixture.deletionState = 'in_progress';
    await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Deletion in progress')).toBeOnTheScreen();
    expect(f.calls.some((call) => call.method === 'POST' && call.path === '/auth/deletion/retry')).toBe(true);
    await f.app.unmount();
  });

  it('does not claim success when no answer arrives: it checks the receipt', async () => {
    const f = await mount('/account/privacy/delete', { deleteFails: true, deletionState: 'unknown' });
    await fireEvent.press(await screen.findByRole('checkbox', { name: 'I understand this cannot be undone' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Delete account' }));
    expect(await screen.findByText("We couldn't confirm your request.")).toBeOnTheScreen();
    expect(f.manager.getState().status).toBe('signed_in');
    await fireEvent.press(screen.getByRole('button', { name: 'Check' }));
    expect(await screen.findByText('Your request did not arrive.')).toBeOnTheScreen();
    expect(f.store.getItem('ks.deletion.receipt')).toBeNull();
    expect(f.manager.getState().status).toBe('signed_in');
    await f.app.unmount();
  });
});
