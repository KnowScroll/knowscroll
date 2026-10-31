import { QueryClient } from '@tanstack/react-query';
import { Slot } from 'expo-router';
import { render } from '@testing-library/react-native';
import { fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import type { ReactNode } from 'react';
import { createAccountScopeManager, memoryStore } from '@knowscroll/client-core';
import { DisplayProvider, Text, useDisplay, useTalkTheme } from '@knowscroll/ui';
import { AccountScopeProvider } from '../../providers/account-scope';
import { DevicePreferencesProvider, PreferredDisplay, PreferredTalkTheme } from '../../providers/device-preferences';
import { AccessibilityScreen } from './accessibility-screen';
import { AccountScreen } from './account-screen';
import { defaultDevicePreferences, type DevicePreferences } from './device-preferences';
import { NotificationsScreen } from './notifications-screen';

const mockWrite = jest.fn<void, [string]>();
jest.mock('../../platform/device-preferences-store', () => ({
  devicePreferencesStore: { read: () => null, write: (value: string) => mockWrite(value) },
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
const scopeField = { accountId: account.accountId, privacyEpoch: 1 };

interface Profile {
  handle: string;
  displayName: string;
  revision: number;
}

/** Real scope manager, provider and screens over authored HTTP answers. */
async function mount(initialUrl: string, options: { profile?: Profile | null; preferences?: DevicePreferences } = {}) {
  const state = { profile: options.profile === undefined ? null : options.profile };
  const calls: { path: string; body: unknown }[] = [];
  const manager = createAccountScopeManager({
    baseUrl: 'https://fixture.invalid',
    platform: 'web',
    store: memoryStore(),
    newQueryClient: () => new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } }),
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      const body: unknown =
        request.method === 'POST'
          ? await request
              .clone()
              .json()
              .catch(() => undefined)
          : undefined;
      calls.push({ path, body });
      if (path === '/auth/session') return json({ account, client: 'web', expiresAt: '2026-12-01T00:00:00.000Z' });
      if (path === '/v1/account/sessions') return json({ sessions: [] });
      if (path === '/v1/privacy/recording/read') {
        const input = body as { readId: string; target: unknown };
        return json({
          version: 'recording-policy.v1',
          ...input,
          scope: scopeField,
          revision: 0,
          policy: { on: true, generation: 1 },
        });
      }
      if (path === '/v1/social/profile' && request.method === 'GET')
        return json(
          state.profile === null
            ? { version: 'sharing.v1', scope: scopeField, status: 'unclaimed', profileRevision: 0 }
            : {
                version: 'sharing.v1',
                scope: scopeField,
                status: 'claimed',
                profileRevision: state.profile.revision,
                person: {
                  kind: 'person',
                  personId: '0199a000-0000-7000-8000-0000000000b1',
                  handle: state.profile.handle,
                  displayName: state.profile.displayName,
                },
              },
        );
      if (path === '/v1/social/profile') {
        const input = body as {
          commandId: string;
          expectedProfileRevision: number;
          handle: string;
          displayName: string;
        };
        state.profile = {
          handle: input.handle,
          displayName: input.displayName,
          revision: input.expectedProfileRevision + 1,
        };
        return json({
          version: 'sharing.v1',
          scope: scopeField,
          commandId: input.commandId,
          recordedAt: '2026-10-24T10:00:00.000Z',
          replayed: false,
          outcome: 'accepted',
          operation: 'profile.set',
          baseProfileRevision: input.expectedProfileRevision,
          acceptedProfileRevision: input.expectedProfileRevision + 1,
        });
      }
      return json({ type: 'tag:fixture', title: 'NOT_FOUND', status: 404, code: 'NOT_FOUND' }, { status: 404 });
    },
  });
  const Layout = () => (
    <AccountScopeProvider manager={manager}>
      <Slot />
    </AccountScopeProvider>
  );
  const wrapper = ({ children }: { children: ReactNode }) => (
    <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: false }}>
      <DevicePreferencesProvider initial={options.preferences ?? defaultDevicePreferences}>
        <PreferredDisplay>{children}</PreferredDisplay>
      </DevicePreferencesProvider>
    </DisplayProvider>
  );
  const app = await renderRouter(
    {
      _layout: Layout,
      account: () => <AccountScreen />,
      'account/notifications': () => <NotificationsScreen />,
      'account/accessibility': () => <AccessibilityScreen />,
    },
    { initialUrl, wrapper },
  );
  return { app, state, calls };
}

beforeEach(() => {
  mockNextId = 0;
  mockWrite.mockClear();
});

describe('P01 identity card', () => {
  it('shows the public name, handle and email, and Edit saves a new name against the revision that was read', async () => {
    const f = await mount('/account', { profile: { handle: 'asha.k', displayName: 'Asha', revision: 3 } });
    expect(await screen.findByText('Asha')).toBeOnTheScreen();
    expect(screen.getByText('@asha.k · person@fixture.invalid')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Edit your profile' }));
    await fireEvent.changeText(screen.getByLabelText('Display name'), 'Asha Kapoor');
    await fireEvent.press(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByText('Asha Kapoor')).toBeOnTheScreen());
    expect(f.calls.find((call) => call.path === '/v1/social/profile' && call.body !== undefined)?.body).toMatchObject({
      expectedProfileRevision: 3,
      handle: 'asha.k',
      displayName: 'Asha Kapoor',
    });
    expect(screen.queryByLabelText('Display name')).toBeNull();
    await f.app.unmount();
  });

  it('shows only the email before a profile is chosen, and Edit sets one up', async () => {
    const f = await mount('/account', { profile: null });
    expect(await screen.findByText('person@fixture.invalid')).toBeOnTheScreen();
    await fireEvent.press(await screen.findByRole('button', { name: 'Set up your profile' }));
    expect(screen.getByLabelText('Your handle')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await fireEvent.changeText(screen.getByLabelText('Display name'), 'Asha');
    await fireEvent.changeText(screen.getByLabelText('Your handle'), 'asha.k');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
    await f.app.unmount();
  });

  it('links to Notifications and Accessibility & playback', async () => {
    const f = await mount('/account');
    await fireEvent.press(await screen.findByRole('link', { name: 'Notifications' }));
    expect(f.app.getPathname()).toBe('/account/notifications');
    await f.app.unmount();
  });
});

describe('P01 Notifications', () => {
  it('turns the ready-request notice off and keeps the choice on this device', async () => {
    const f = await mount('/account/notifications');
    const ready = await screen.findByRole('switch', { name: 'Ready requests', checked: true });
    await fireEvent.press(ready);
    expect(screen.getByRole('switch', { name: 'Ready requests', checked: false })).toBeOnTheScreen();
    expect(JSON.parse(mockWrite.mock.calls.at(-1)?.[0] ?? '{}')).toMatchObject({ readyNotices: false });
    await f.app.unmount();
  });
});

function MotionProbe() {
  const { reducedMotion, textScale } = useDisplay();
  return (
    <>
      <MotionText label="motion" value={String(reducedMotion)} />
      <MotionText label="scale" value={String(textScale)} />
    </>
  );
}
function MotionText({ label, value }: { label: string; value: string }) {
  return <Text variant="meta">{`${label}=${value}`}</Text>;
}

describe('P01 Accessibility & playback', () => {
  it('lays the person’s motion and text size over the device and keeps them', async () => {
    const f = await mount('/account/accessibility');
    expect(await screen.findByRole('radio', { name: 'Follow my device', checked: true })).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('radio', { name: 'Always reduce motion' }));
    await fireEvent.press(screen.getByRole('radio', { name: 'Larger' }));
    await fireEvent.press(screen.getByRole('switch', { name: 'Start Reels with sound' }));
    expect(JSON.parse(mockWrite.mock.calls.at(-1)?.[0] ?? '{}')).toEqual({
      motion: 'reduce',
      textSize: 'larger',
      reelSound: false,
      readyNotices: true,
      talkTheme: 'sky',
    });
    expect(screen.getByRole('radio', { name: 'Always reduce motion', checked: true })).toBeOnTheScreen();
    await f.app.unmount();
  });

  it('starts Talk on the dark sky, offers Paper, and keeps the choice on this device only', async () => {
    const f = await mount('/account/accessibility');
    expect(await screen.findByRole('radio', { name: 'Dark sky', checked: true })).toBeOnTheScreen();
    expect(screen.getByRole('radio', { name: 'Paper', checked: false })).toBeOnTheScreen();
    const requestsBefore = f.calls.length;
    await fireEvent.press(screen.getByRole('radio', { name: 'Paper' }));
    expect(screen.getByRole('radio', { name: 'Paper', checked: true })).toBeOnTheScreen();
    expect(JSON.parse(mockWrite.mock.calls.at(-1)?.[0] ?? '{}')).toMatchObject({ talkTheme: 'paper' });
    // Nothing goes to the server: it is a choice about how this device looks (D-057, D-151).
    expect(f.calls).toHaveLength(requestsBefore);
    await fireEvent.press(screen.getByRole('radio', { name: 'Dark sky' }));
    expect(JSON.parse(mockWrite.mock.calls.at(-1)?.[0] ?? '{}')).toMatchObject({ talkTheme: 'sky' });
    await f.app.unmount();
  });
});

function ThemeProbe() {
  const theme = useTalkTheme();
  return <Text variant="meta">{`theme=${theme.name}`}</Text>;
}

describe('the Talk theme', () => {
  it('is the dark sky by default and Paper once chosen, for everything below the provider', async () => {
    const tree = (preferences: DevicePreferences) => (
      <DevicePreferencesProvider initial={preferences}>
        <PreferredTalkTheme>
          <ThemeProbe />
        </PreferredTalkTheme>
      </DevicePreferencesProvider>
    );
    const first = await render(tree(defaultDevicePreferences));
    expect(screen.getByText('theme=sky')).toBeOnTheScreen();
    await first.unmount();
    const second = await render(tree({ ...defaultDevicePreferences, talkTheme: 'paper' }));
    expect(screen.getByText('theme=paper')).toBeOnTheScreen();
    await second.unmount();
  });
});

describe('device choices over the display', () => {
  it('reduces motion and enlarges text below the provider, never the other way', async () => {
    const tree = (preferences: DevicePreferences, systemReduced: boolean) => (
      <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: systemReduced }}>
        <DevicePreferencesProvider initial={preferences}>
          <PreferredDisplay>
            <MotionProbe />
          </PreferredDisplay>
        </DevicePreferencesProvider>
      </DisplayProvider>
    );
    const first = await render(tree({ ...defaultDevicePreferences, motion: 'reduce', textSize: 'largest' }, false));
    expect(screen.getByText('motion=true')).toBeOnTheScreen();
    expect(screen.getByText('scale=1.3')).toBeOnTheScreen();
    await first.unmount();
    const second = await render(tree(defaultDevicePreferences, true));
    expect(screen.getByText('motion=true')).toBeOnTheScreen();
    expect(screen.getByText('scale=1')).toBeOnTheScreen();
    await second.unmount();
  });
});
