import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { createAccountScope, memoryStore, type AccountScope } from '@knowscroll/client-core';
import { DisplayProvider } from '@knowscroll/ui';
import { ReelEncounter } from './reel-encounter';

// The real component, AccountScope and response parsing over labelled HTTP fixtures. Only the
// player view, the recorder and route focus are stand-ins: no playback or backend is claimed.
let mockFocused = true;
jest.mock('expo-router', () => ({ useIsFocused: () => mockFocused }));
const mockViewProps = jest.fn<
  void,
  [{ active: boolean; controls?: { tapToToggle?: boolean; controlsRef: unknown } }]
>();
const mockToggle = jest.fn();
const mockSeekBy = jest.fn();
const mockToggleMuted = jest.fn();
jest.mock('../reel/activated-reel-view', () => ({
  ActivatedReelView: (props: {
    active: boolean;
    controls?: { controlsRef: { current: unknown } };
    children?: (playback: unknown) => unknown;
  }) => {
    mockViewProps(props);
    if (props.controls) props.controls.controlsRef.current = { toggle: mockToggle, seekBy: mockSeekBy };
    return props.children?.({
      positionMs: 0,
      durationMs: 20000,
      playing: false,
      status: 'ready',
      muted: false,
      toggleMuted: mockToggleMuted,
    });
  },
}));
const mockRecorder = {
  sessionId: 'CI recorder',
  sample: jest.fn(),
  discontinuity: jest.fn(),
  flush: jest.fn(),
  suspend: jest.fn(),
  resume: jest.fn(),
  end: jest.fn(),
};
jest.mock('@knowscroll/client-core', () => ({
  ...jest.requireActual<object>('@knowscroll/client-core'),
  createReelRecorder: () => mockRecorder,
}));
jest.mock('../../platform/command-id', () => ({
  newCommandId: () => jest.requireActual<{ randomUUID: () => string }>('node:crypto').randomUUID(),
}));

const id = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

function fixtureScope(): AccountScope {
  return createAccountScope({
    account: { accountId: id(3), universeId: id(4), privacyEpoch: 1, email: 'fixture@threads.test' },
    baseUrl: 'https://fixture.threads.test',
    authorization: () => undefined,
    store: memoryStore(),
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      const body = (await request.clone().json()) as Record<string, unknown>;
      if (path === '/v1/privacy/recording/read') {
        const claim = request.headers.get('x-ks-scope')!.split(':');
        return json({
          version: 'recording-policy.v1',
          ...body,
          scope: { accountId: claim[0], privacyEpoch: Number(claim[1]) },
          revision: 1,
          policy: { on: true, generation: 1 },
        });
      }
      if (path === '/v1/experience/open')
        return json({
          commandId: body['commandId'],
          exposureId: id(5),
          assetId: id(6),
          assetRevision: 1,
          kind: 'reel',
          revision: 1,
          replayed: false,
        });
      if (path === '/v1/media/grants')
        return json({
          document: {
            schemaVersion: 'reel-document.v1',
            assetId: id(6),
            revision: 1,
            title: 'Fixture Reel',
            summary: 'CI only',
            language: 'en',
            truthLabel: 'generated',
            fixture: true,
            captions: 'burned_in',
            mediaKey: `sha256/aa/${'a'.repeat(64)}.mp4`,
            durationMs: 20000,
            width: 1080,
            height: 1920,
          },
          path: '/media/fixture',
          expiresAt: '2099-10-20T18:00:00.000Z',
        });
      if (path === '/v1/experience/activate')
        return json({
          commandId: body['commandId'],
          exposureId: id(5),
          activatedAt: '2026-10-24T08:00:00.000Z',
          revision: 1,
          replayed: false,
        });
      throw new Error(`Unexpected fixture request: ${path}`);
    },
  });
}

const encounter = (scope: AccountScope, active = true) => (
  <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
    <ReelEncounter scope={scope} assetId={id(6)} title="The edge" active={active} />
  </DisplayProvider>
);
const lastActive = () => mockViewProps.mock.calls.at(-1)?.[0].active;

beforeEach(() => {
  mockFocused = true;
  mockViewProps.mockClear();
  mockRecorder.discontinuity.mockClear();
});

describe('a Reel played inside a thread or a snippet viewer', () => {
  it('shows only a poster until the person presses Watch, and opens nothing before that', async () => {
    const scope = fixtureScope();
    const fetched = jest.spyOn(globalThis, 'fetch');
    await render(encounter(scope));
    expect(screen.getByRole('button', { name: 'Watch' })).toBeOnTheScreen();
    expect(mockViewProps).not.toHaveBeenCalled();
    expect(fetched).not.toHaveBeenCalled();
  });

  it('pauses the player when another screen takes focus, and does not start it again by itself', async () => {
    const scope = fixtureScope();
    const view = await render(encounter(scope));
    await fireEvent.press(screen.getByRole('button', { name: 'Watch' }));
    await waitFor(() => expect(lastActive()).toBe(true));

    mockFocused = false;
    await act(() => view.rerender(encounter(scope)));
    expect(lastActive()).toBe(false);
    expect(mockRecorder.discontinuity).toHaveBeenCalled();

    // Coming back to the screen makes the player eligible again; playing is still the person's choice.
    mockFocused = true;
    await act(() => view.rerender(encounter(scope)));
    expect(lastActive()).toBe(true);
  });

  it('stays paused while the thread says so, whether or not the screen has focus', async () => {
    const scope = fixtureScope();
    const view = await render(encounter(scope));
    await fireEvent.press(screen.getByRole('button', { name: 'Watch' }));
    await waitFor(() => expect(lastActive()).toBe(true));
    await act(() => view.rerender(encounter(scope, false)));
    expect(lastActive()).toBe(false);
    expect(mockRecorder.discontinuity).toHaveBeenCalled();
  });

  it('draws its own compact controls, the only ones on the screen, wired to the player', async () => {
    const scope = fixtureScope();
    await render(encounter(scope));
    await fireEvent.press(screen.getByRole('button', { name: 'Watch' }));
    await waitFor(() => expect(lastActive()).toBe(true));
    expect(mockViewProps.mock.calls.at(-1)?.[0].controls?.tapToToggle).toBe(false);

    await fireEvent.press(screen.getByRole('button', { name: 'Back 10s' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Play' }));
    await fireEvent.press(screen.getByRole('togglebutton', { name: 'Mute' }));

    expect(mockSeekBy).toHaveBeenCalledWith(-10);
    expect(mockToggle).toHaveBeenCalledTimes(1);
    expect(mockToggleMuted).toHaveBeenCalledTimes(1);
  });
});
