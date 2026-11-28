import type * as React from 'react';
import type * as ReactNative from 'react-native';
import type * as FakeGpu from './space/fake-space-gpu';
import { type EffectCallback } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { AppState } from 'react-native';
import { DisplayProvider } from '@knowscroll/ui';
import { UniverseScreen } from './universe-screen';
import { resetFakeGpu } from './space/fake-space-gpu';
import { fixtureId, universeHarness } from './universe.fixture';
import { DevicePreferencesProvider } from '../../providers/device-preferences';
import { defaultDevicePreferences } from '../account/device-preferences';
import { universeSessionFor } from './use-universe-session';
import type { AccountScope } from '@knowscroll/client-core';

/**
 * The wiring of the planet's two maps into the Universe screen. The new look's stage draws with three.js, which no
 * test here has: it is stood in for by a button that stands for "a tap on bare ground", so what is under test is the
 * screen's own part (when the chip and the maps exist, what is hidden under them, how Back leaves them). The stage,
 * the press layer and the keys are proved in a real browser by `e2e/universe-maps-smoke.spec.ts`.
 */
let mockScope: AccountScope;
jest.mock('../../platform/command-id', () => {
  let next = 30000;
  return { newCommandId: () => `0199a000-0000-7000-8000-${(next++).toString(16).padStart(12, '0')}` };
});
jest.mock('./space/space-canvas', () => ({
  SpaceCanvas: jest.requireActual<typeof FakeGpu>('./space/fake-space-gpu').fakeGpu.Canvas,
}));
jest.mock('./space/load-space-renderer', () => ({
  loadSpaceRenderer: () => jest.requireActual<typeof FakeGpu>('./space/fake-space-gpu').fakeGpu.load(),
  loadFirstOpenRenderer: () => () => jest.requireActual<typeof FakeGpu>('./space/fake-space-gpu').fakeGpu.load(),
}));
// The new look's stage is a stand-in that says what the screen gave it.
jest.mock('./voyage/voyage-stage', () => {
  const { Pressable, View: Box } = jest.requireActual<typeof ReactNative>('react-native');
  return {
    VoyageStage: ({ onMap }: { onMap?: () => void }) => (
      <Box testID="voyage-stage-stand-in">
        {onMap ? (
          <Pressable testID="ground-tap" accessibilityRole="button" accessibilityLabel="Bare ground" onPress={onMap} />
        ) : null}
      </Box>
    ),
  };
});
const mockNavigate = jest.fn();
jest.mock('../../providers/account-scope', () => ({
  useAccountScope: () => ({ state: { status: 'signed_in', scope: mockScope } }),
  useAccountInitial: () => 'F',
}));
jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof React>('react');
  return {
    useFocusEffect: (effect: EffectCallback) => useEffect(effect, [effect]),
    useIsFocused: () => true,
    useRouter: () => ({ navigate: mockNavigate, push: jest.fn(), canGoBack: () => false }),
    useLocalSearchParams: () => ({}),
  };
});
jest.mock('expo-status-bar', () => ({ setStatusBarStyle: jest.fn() }));
jest.mock('../../platform/device-preferences-store', () => ({
  devicePreferencesStore: { read: () => null, write: () => undefined },
}));
beforeEach(() => {
  resetFakeGpu();
  mockNavigate.mockReset();
  Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true });
});

const PLANET = fixtureId(12);
/** The map on screen, found by what it calls itself. */
async function mapNamed(label: string) {
  const map = await screen.findByTestId('map-screen');
  expect(map.props.accessibilityLabel).toBe(label);
  return map;
}
const phone = (trial: boolean) => (
  <DevicePreferencesProvider initial={{ ...defaultDevicePreferences, universeTrial: trial }}>
    <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
      <UniverseScreen />
    </DisplayProvider>
  </DevicePreferencesProvider>
);

/** Renders the Universe and flies it to CI planet 2's ground, the way the screen's own session is driven. */
async function onTheGround(trial: boolean) {
  const h = universeHarness(5, 0, 2);
  mockScope = h.scope;
  const view = await render(phone(trial));
  await waitFor(() => expect(universeSessionFor(h.scope).getState().read.status).toBe('ready'));
  const session = universeSessionFor(h.scope);
  await act(() => {
    session.focus(fixtureId(10));
    session.focus(PLANET);
    session.land();
  });
  return { h, view, session };
}

describe('with the switch off', () => {
  it('has no chip, no press layer and no map on a landed planet, and a region is the old card', async () => {
    const { h, view, session } = await onTheGround(false);
    expect(session.getState()).toMatchObject({ focusId: PLANET, landed: true });
    expect(screen.queryByTestId('universe-map-open')).toBeNull();
    expect(screen.queryByText(/^Map of /)).toBeNull();
    expect(screen.queryByTestId('voyage-ground-press')).toBeNull();
    expect(screen.queryByTestId('universe-maps')).toBeNull();
    expect(screen.queryByTestId('voyage-stage-stand-in')).toBeNull();
    await act(() => {
      session.focus(fixtureId(14));
    });
    expect(screen.getByTestId('universe-region-card')).toBeOnTheScreen();
    expect(screen.queryByTestId('map-screen')).toBeNull();
    await act(() => h.scope.end());
    await view.unmount();
  });

  it('refuses to open a map from the session, as the old screen has none to show', async () => {
    const { h, view, session } = await onTheGround(false);
    expect(screen.queryByTestId('universe-maps')).toBeNull();
    await act(() => {
      session.showOverlay('planet-map');
    });
    // Nothing draws an overlay it does not know: the screen shows the planet's own map as it was.
    expect(screen.queryByTestId('map-screen')).toBeNull();
    await act(() => h.scope.end());
    await view.unmount();
  });
});

describe('with the switch on', () => {
  it('offers the chip at the ground, opens the planet’s map from it, and hides the stage under it', async () => {
    const { h, view } = await onTheGround(true);
    const chip = await screen.findByRole('button', { name: 'Map of CI planet 2' });
    expect(screen.getByTestId('voyage-stage-stand-in')).toBeOnTheScreen();
    await fireEvent.press(chip);
    const map = await mapNamed('Map of CI planet 2');
    expect(map).toBeOnTheScreen();
    // The stage stays mounted (a scene is costly to build again) but is out of reach.
    expect(screen.getByTestId('voyage-stage-stand-in', { includeHiddenElements: true })).toBeTruthy();
    expect(screen.queryByTestId('voyage-stage-stand-in')).toBeNull();
    expect(screen.getByTestId('universe-map', { includeHiddenElements: true }).props.pointerEvents).toBe('none');
    // The header, chips and card are not there to be reached behind it.
    expect(screen.queryByTestId('universe-map-open')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Back to CI system 0' })).toBeNull();
    await act(() => h.scope.end());
    await view.unmount();
  });

  it('opens the same map from a tap on bare ground, and Back returns to the ground with the chip there again', async () => {
    const { h, view, session } = await onTheGround(true);
    await fireEvent.press(await screen.findByTestId('ground-tap'));
    expect(await mapNamed('Map of CI planet 2')).toBeOnTheScreen();
    expect(session.getState().overlay).toBe('planet-map');
    await fireEvent.press(screen.getByRole('button', { name: 'Back to CI planet 2' }));
    expect(session.getState()).toMatchObject({ overlay: null, focusId: PLANET, landed: true });
    expect(screen.queryByTestId('map-screen')).toBeNull();
    expect(await screen.findByRole('button', { name: 'Map of CI planet 2' })).toBeOnTheScreen();
    await act(() => h.scope.end());
    await view.unmount();
  });

  it('lists only the formed regions, opens a region’s map from a row, and Back goes map by map', async () => {
    const { h, view, session } = await onTheGround(true);
    await fireEvent.press(await screen.findByRole('button', { name: 'Map of CI planet 2' }));
    const rows = await screen.findAllByRole('button', { name: /, a region$/ });
    expect(rows.map((row) => (row.props as { accessibilityLabel: string }).accessibilityLabel)).toEqual([
      'CI region 4, a region',
      'CI region 5, a region',
      'CI region 6, a region',
    ]);
    await fireEvent.press(rows[0]!);
    expect(await mapNamed('CI region 4, a region of CI planet 2')).toBeOnTheScreen();
    expect(session.getState()).toMatchObject({ overlay: 'place', mapBehind: true });
    // The region's own map takes the card's place.
    expect(screen.queryByTestId('universe-region-card')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('map-contents')).toBeOnTheScreen());
    await fireEvent.press(screen.getByRole('button', { name: 'Back to Map of CI planet 2' }));
    expect(await mapNamed('Map of CI planet 2')).toBeOnTheScreen();
    expect(session.getState().overlay).toBe('planet-map');
    await fireEvent.press(screen.getByRole('button', { name: 'Back to CI planet 2' }));
    expect(session.getState().overlay).toBeNull();
    await act(() => h.scope.end());
    await view.unmount();
  });

  it('opens a region’s own map from the ground at once, and its Back goes to the region’s ground', async () => {
    const { h, view, session } = await onTheGround(true);
    await act(() => {
      session.focus(fixtureId(14));
    });
    expect(await mapNamed('CI region 4, a region of CI planet 2')).toBeOnTheScreen();
    expect(screen.queryByTestId('universe-region-card')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Back to CI planet 2' }));
    expect(session.getState()).toMatchObject({ overlay: null, focusId: fixtureId(14) });
    await act(() => h.scope.end());
    await view.unmount();
  });

  it('offers nothing on a globe, and nothing for a planet with no formed region', async () => {
    const h = universeHarness(5, 0, 0);
    mockScope = h.scope;
    const view = await render(phone(true));
    await waitFor(() => expect(universeSessionFor(h.scope).getState().read.status).toBe('ready'));
    const session = universeSessionFor(h.scope);
    await act(() => {
      session.focus(fixtureId(10));
      session.focus(PLANET);
    });
    expect(screen.queryByRole('button', { name: /^Map of / })).toBeNull();
    expect(screen.queryByTestId('ground-tap')).toBeNull();
    await act(() => h.scope.end());
    await view.unmount();

    // Four places: the planet has no region at all, so there is no map to open on its ground.
    const bare = universeHarness(4);
    mockScope = bare.scope;
    const next = await render(phone(true));
    await waitFor(() => expect(universeSessionFor(bare.scope).getState().read.status).toBe('ready'));
    await act(() => {
      universeSessionFor(bare.scope).focus(fixtureId(10));
      universeSessionFor(bare.scope).focus(PLANET);
      universeSessionFor(bare.scope).land();
    });
    expect(universeSessionFor(bare.scope).getState()).toMatchObject({ focusId: PLANET, landed: true });
    expect(screen.queryByRole('button', { name: /^Map of / })).toBeNull();
    expect(screen.queryByTestId('ground-tap')).toBeNull();
    await act(() => bare.scope.end());
    await next.unmount();
  });
});
