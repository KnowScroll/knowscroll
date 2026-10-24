import { QueryClient } from '@tanstack/react-query';
import { Slot } from 'expo-router';
import { fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import type { ReactNode } from 'react';
import { createAccountScopeManager, memoryStore } from '@knowscroll/client-core';
import { DisplayProvider } from '@knowscroll/ui';
import { AccountScopeProvider } from '../../providers/account-scope';
import { AccountScreen } from '../account/account-screen';
import { PrivacyClearScreen, PrivacyScreen } from './privacy-screen';

jest.mock('../../platform/command-id', () => ({ newCommandId: () => '0199a000-0000-7000-8000-000000000003' }));
const account = {
  accountId: '0199a000-0000-7000-8000-000000000001',
  universeId: '0199a000-0000-7000-8000-000000000002',
  privacyEpoch: 1,
  email: 'privacy@fixture.invalid',
};
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
/** Authored HTTP fixtures, actual scope manager/provider remount and actual P02 controls. */
async function mount(options: { unknown?: boolean; completed?: boolean; initialUrl?: string } = {}) {
  let epoch = 1;
  let failed = options.unknown === true;
  let recorded = false;
  const calls: { path: string; body: Record<string, unknown>; scope: string | null }[] = [];
  const receipt = {
    commandId: '0199a000-0000-7000-8000-000000000003',
    fromEpoch: 1,
    toEpoch: 2,
    recordedAt: '2026-10-22T10:00:00.000Z',
  };
  const manager = createAccountScopeManager({
    baseUrl: 'https://fixture.invalid',
    platform: 'web',
    store: memoryStore(),
    newQueryClient: () => new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } }),
    fetch: async (request) => {
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
        return json({
          account: { ...account, privacyEpoch: epoch },
          client: 'web',
          expiresAt: '2026-12-01T00:00:00.000Z',
        });
      const body = (await request.json()) as Record<string, unknown>;
      calls.push({ path, body, scope: request.headers.get('x-ks-scope') });
      if (path.endsWith('/clear-exploration')) {
        epoch = 2;
        if (failed) throw new Error('fixture unknown reply');
        recorded = true;
        return json({
          version: 'clear-exploration.v1',
          ...receipt,
          outcome: 'accepted',
          operation: 'privacy.clear-exploration',
          replayed: calls.filter((c) => c.path.endsWith('/clear-exploration')).length > 1,
        });
      }
      return json({
        version: 'clear-exploration.v1',
        scope: { accountId: account.accountId, privacyEpoch: epoch },
        target: body.target,
        status: recorded ? (options.completed ? 'completed_live' : 'pending') : 'not_recorded',
        ...(recorded ? { receipt, ...(options.completed ? {} : { phase: 'removing_live_data' }) } : {}),
      });
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
      account: () => <AccountScreen />,
      'account/privacy/index': () => <PrivacyScreen />,
      'account/privacy/clear': () => <PrivacyClearScreen />,
    },
    { initialUrl: options.initialUrl ?? '/account/privacy/clear', wrapper },
  );
  return {
    app,
    manager,
    calls,
    succeed: () => {
      failed = false;
    },
  };
}
async function confirm() {
  await fireEvent.press(screen.getByRole('checkbox', { name: 'I understand this cannot be undone' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Clear exploration' }));
}
describe('P02 selective Clear', () => {
  it('links from account and requires explicit acknowledgement before sending, then shows pending after scope remount', async () => {
    const f = await mount({ initialUrl: '/account' });
    await fireEvent.press(await screen.findByRole('link', { name: 'Privacy & history' }));
    expect(f.app.getPathname()).toBe('/account/privacy');
    await fireEvent.press(await screen.findByRole('link', { name: 'Clear exploration' }));
    expect(f.app.getPathname()).toBe('/account/privacy/clear');
    await screen.findByText('No clear request is recorded for this account.');
    expect(screen.getByRole('button', { name: 'Clear exploration' })).toBeDisabled();
    expect(screen.getByText(/Keep items and their saved places stay/)).toBeOnTheScreen();
    const before = f.manager.getState();
    if (before.status !== 'signed_in') throw new Error('fixture scope missing');
    await confirm();
    expect(await screen.findByText('Your exploration history and universe are being removed.')).toBeOnTheScreen();
    expect(before.scope.active).toBe(false);
    expect(f.calls.filter((c) => c.path.endsWith('/clear-exploration'))).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Clear exploration' })).toBeNull();
    await f.app.unmount();
  });
  it('retains original same-body Retry through the actual provider scope remount without offering a new clear', async () => {
    const f = await mount({ unknown: true });
    await screen.findByText('No clear request is recorded for this account.');
    await confirm();
    const retry = await screen.findByRole('button', { name: 'Retry the same clear request' });
    expect(
      screen.getByText('No receipt appeared in this check. Your original request may still arrive.'),
    ).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Clear exploration' })).toBeNull();
    f.succeed();
    await fireEvent.press(retry);
    await screen.findByText('Your exploration history and universe are being removed.');
    const sends = f.calls.filter((c) => c.path.endsWith('/clear-exploration'));
    expect(sends).toHaveLength(2);
    expect(sends[1]?.body).toEqual(sends[0]?.body);
    expect(sends[0]?.scope).toBe(`${account.accountId}:1`);
    expect(sends[1]?.scope).toBe(`${account.accountId}:2`);
    await f.app.unmount();
  });
  it('distinguishes completed live removal from external/backup expiry without inventing dates', async () => {
    const f = await mount({ completed: true });
    await screen.findByText('No clear request is recorded for this account.');
    await confirm();
    expect(await screen.findByText('Live exploration removal is complete.')).toBeOnTheScreen();
    expect(screen.getByText(/Context already sent to an AI provider cannot be recalled/)).toBeOnTheScreen();
    expect(screen.getByText(/No expiry date is confirmed here/)).toBeOnTheScreen();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Clear exploration' })).toBeDisabled());
    await f.app.unmount();
  });
});
