import type * as React from 'react';
import type * as Ui from '@knowscroll/ui';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { QueryClientProvider } from '@tanstack/react-query';
import { AppState } from 'react-native';
import { DisplayProvider } from '@knowscroll/ui';
import { harness, id } from '../encounter/encounter-session.fixture';
import { encounterSessionFor } from '../encounter/use-encounter-session';
import { SignedInExplore } from './explore-screen';

// Real Explore screen, encounter session, AccountScope and HTTP parsing over labelled CI fixtures. The
// video player is a stand-in that draws only the screen's own chrome; no playback or backend is claimed.
jest.mock('expo-video', () => ({ VideoView: 'VideoView', useVideoPlayer: jest.fn() }));
jest.mock('../../platform/command-id', () => {
  let next = 5000;
  return { newCommandId: () => `0199a000-0000-7000-8000-${String(++next).padStart(12, '0')}` };
});
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(() => Promise.resolve(true)) }));
let mockScope: unknown;
jest.mock('../../providers/account-scope', () => ({
  useAccountScope: () => ({ state: { status: 'signed_in', scope: mockScope }, manager: { refresh: jest.fn() } }),
}));
jest.mock('../../platform/api', () => ({
  appApiOrigin: () => ({ ok: true, baseUrl: 'https://fixture.encounter.test' }),
}));
jest.mock('@knowscroll/ui', () => ({
  ...jest.requireActual<typeof Ui>('@knowscroll/ui'),
  ReelPlayer: jest.fn((props: Ui.ReelPlayerProps) =>
    typeof props.children === 'function'
      ? props.children({
          positionMs: 31000,
          durationMs: props.durationMs,
          playing: false,
          status: 'ready',
          muted: false,
          toggleMuted: () => undefined,
        })
      : (props.children ?? null),
  ),
}));
const mockNavigate = jest.fn();
jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof React>('react');
  return {
    useRouter: () => ({ canGoBack: () => false, back: jest.fn(), navigate: mockNavigate }),
    useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]),
  };
});

beforeEach(() => {
  // The screen is in the foreground: only a foreground Explore activates an offer.
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
});

async function openExplore(setup?: (h: ReturnType<typeof harness>) => void) {
  const h = harness();
  setup?.(h);
  const app = await render(
    <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
      <QueryClientProvider client={h.scope.queryClient}>
        <SignedInExplore scope={h.scope} />
      </QueryClientProvider>
    </DisplayProvider>,
  );
  mockScope = h.scope;
  await screen.findByRole('button', { name: 'More options' });
  // The screen drives the scope's own session; the harness only supplies the scope and the HTTP fixture.
  return { h: { ...h, session: encounterSessionFor(h.scope) }, app };
}

describe('Explore Reel as drawn in E01', () => {
  it('shows the one action set, the format switch and the menu, and none of the old utility controls', async () => {
    const { h, app } = await openExplore();
    try {
      expect(screen.getByLabelText('Format of this explanation')).toBeOnTheScreen();
      expect(screen.getByRole('radio', { name: 'Reel', checked: true })).toBeOnTheScreen();
      for (const name of ['Like', 'Save', 'Share', 'Ask about this', 'More options'])
        expect(
          screen.getByRole(name === 'Like' || name === 'Save' ? 'togglebutton' : 'button', { name }),
        ).toBeOnTheScreen();
      expect(screen.getByLabelText('Reel progress')).toBeOnTheScreen();
      expect(screen.getByText('0:31 / 0:20')).toBeOnTheScreen();
      for (const old of ['Keep this place', 'Previous subject', 'Your path', 'Back 10s', 'Forward 10s'])
        expect(screen.queryByRole('button', { name: old })).toBeNull();
    } finally {
      await app.unmount();
      h.scope.end();
    }
  });

  it('shows the first-arrival hint once and keeps it dismissed', async () => {
    const { h, app } = await openExplore();
    try {
      expect(screen.getByLabelText('How to move around')).toBeOnTheScreen();
      await fireEvent.press(screen.getByRole('button', { name: 'Got it' }));
      expect(screen.queryByLabelText('How to move around')).toBeNull();
      expect(h.scope.storage.get('explore.hint.dismissed')).toBe('1');
    } finally {
      await app.unmount();
      h.scope.end();
    }
  });

  it('draws a declared next Part as the yellow edge tab and follows it with its expected link', async () => {
    const { h, app } = await openExplore();
    try {
      const entry = h.session.getState().entry!;
      const link = {
        status: 'ready' as const,
        linkId: id(900),
        target: { assetId: id(901), assetRevision: 2 },
        metadata: { kind: 'reel' as const, title: 'Attention at work', summary: '', language: 'en' },
        relation: { kind: 'series_step' as const, seriesId: 'ci-series', seriesRevision: 1, part: 2 },
      };
      await act(() => {
        entry.context = { ...entry.context, continuations: { ...entry.context.continuations, seriesNext: link } };
        h.session.setOverlay(true);
        h.session.setOverlay(false);
      });
      const tab = await screen.findByRole('button', { name: 'Continue: Part 2, Attention at work' });
      await fireEvent.press(tab);
      await waitFor(() => expect(h.calls.some((call) => call.path === '/v1/experience/navigate')).toBe(true));
      expect(h.calls.find((call) => call.path === '/v1/experience/navigate')?.body.intent).toEqual({
        mode: 'series',
        direction: 'next',
        expectedContinuation: { linkId: id(900), assetId: id(901), assetRevision: 2 },
      });
    } finally {
      await app.unmount();
      h.scope.end();
    }
  });

  it('gives every move a control: the menu moves to the next subject', async () => {
    const { h, app } = await openExplore();
    try {
      await fireEvent.press(screen.getByRole('button', { name: 'More options' }));
      expect(await screen.findByRole('button', { name: 'Next subject' })).toBeOnTheScreen();
      expect(screen.getByRole('button', { name: 'Previous subject' })).toBeOnTheScreen();
      expect(screen.getByRole('link', { name: 'Account and settings' })).toBeOnTheScreen();
      await fireEvent.press(screen.getByRole('button', { name: 'Next subject' }));
      await waitFor(() => expect(h.calls.some((call) => call.path === '/v1/experience/navigate')).toBe(true));
      expect(h.calls.find((call) => call.path === '/v1/experience/navigate')?.body.intent).toEqual({
        mode: 'vertical',
        direction: 'next',
      });
    } finally {
      await app.unmount();
      h.scope.end();
    }
  });
});

describe('Explore sheets', () => {
  it('Share opens the sharing sheet over the encounter and closes back to it', async () => {
    const { h, app } = await openExplore();
    try {
      await fireEvent.press(screen.getByRole('button', { name: 'Share' }));
      expect(await screen.findByRole('button', { name: 'Send to a conversation' })).toBeOnTheScreen();
      expect(screen.getByRole('button', { name: 'Copy link' })).toBeOnTheScreen();
      expect(h.session.getState().overlayOwner).toBe('share');
      await fireEvent.press(screen.getByRole('button', { name: 'Close' }));
      expect(h.session.getState().overlay).toBe(false);
      expect(screen.queryByRole('button', { name: 'Copy link' })).toBeNull();
    } finally {
      await app.unmount();
      h.scope.end();
    }
  });

  it('choosing the missing format opens the request sheet instead of switching', async () => {
    const { h, app } = await openExplore();
    try {
      await fireEvent.press(screen.getByRole('radio', { name: 'Scroll' }));
      expect(await screen.findByText('Ask for something')).toBeOnTheScreen();
      expect(screen.getByText(/Request the same explanation as a Scroll/)).toBeOnTheScreen();
      expect(h.calls.some((call) => call.path === '/v1/experience/navigate')).toBe(false);
    } finally {
      await app.unmount();
      h.scope.end();
    }
  });
});

describe('Explore ending (E08) and nothing more ready (E07)', () => {
  it('a move with nothing more ready says so plainly (E07) and offers another subject, Keep and done', async () => {
    const { h, app } = await openExplore();
    try {
      await fireEvent.press(screen.getByRole('button', { name: 'Got it' }));
      h.setOutcome('exhausted');
      await act(() => h.session.navigate({ mode: 'vertical', direction: 'next' }));
      expect(await screen.findByText("You've seen what's ready for now")).toBeOnTheScreen();
      expect(screen.getByText('More may come later. Here are a few ways to keep going.')).toBeOnTheScreen();
      expect(screen.getByRole('button', { name: 'Another subject' })).toBeOnTheScreen();
      await fireEvent.press(screen.getByRole('link', { name: 'Something you kept' }));
      expect(mockNavigate).toHaveBeenCalledWith('/saved');
      expect(screen.queryByRole('button', { name: 'Keep a way back' })).toBeNull();
      await fireEvent.press(screen.getByRole('button', { name: 'Done for now' }));
      expect(await screen.findByText('A good place to stop')).toBeOnTheScreen();
      expect(screen.getByRole('button', { name: 'Find something new' })).toBeOnTheScreen();
    } finally {
      await app.unmount();
      h.scope.end();
    }
  });

  it('an explicit Done is the ending card with the way back, something different and done', async () => {
    const { h, app } = await openExplore();
    try {
      await fireEvent.press(screen.getByRole('button', { name: 'Got it' }));
      await act(() => h.session.done());
      expect(await screen.findByText('A good place to pause')).toBeOnTheScreen();
      expect(screen.getByRole('button', { name: 'Keep a way back' })).toBeOnTheScreen();
      expect(screen.getByRole('button', { name: 'Something different' })).toBeOnTheScreen();
    } finally {
      await app.unmount();
      h.scope.end();
    }
  });

  it('keeping a way back confirms plainly and offers Keep and Undo', async () => {
    const { h, app } = await openExplore();
    try {
      await fireEvent.press(screen.getByRole('button', { name: 'Got it' }));
      // The stop comes from the thread ending, with the current encounter still the one to keep.
      await act(() => h.session.done());
      await fireEvent.press(await screen.findByRole('button', { name: 'Keep a way back' }));
      expect(await screen.findByText("We'll bring you back here", {}, { timeout: 4000 })).toBeOnTheScreen();
      await fireEvent.press(screen.getByRole('link', { name: 'See it in Keep' }));
      expect(mockNavigate).toHaveBeenCalledWith('/saved');
      expect(screen.getByRole('button', { name: 'Undo' })).toBeOnTheScreen();
    } finally {
      await app.unmount();
      h.scope.end();
    }
  });
});
