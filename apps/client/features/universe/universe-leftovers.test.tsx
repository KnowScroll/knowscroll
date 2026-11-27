import type * as React from 'react';
import type * as FakeGpu from './space/fake-space-gpu';
import type * as SceneCore from '@knowscroll/scene-core';
import { type EffectCallback } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { AppState } from 'react-native';
import type { AccountScope } from '@knowscroll/client-core';
import { DisplayProvider } from '@knowscroll/ui';
import { DevicePreferencesProvider } from '../../providers/device-preferences';
import { defaultDevicePreferences } from '../account/device-preferences';
import { UniverseScreen } from './universe-screen';
import { resetFakeGpu } from './space/fake-space-gpu';
import { space } from '@knowscroll/design-tokens';
import { universeHarness } from './universe.fixture';

/**
 * Chrome the new look shares with the old: the List and Lately chips, Lately's names, "Return to", and Simple drawing's
 * fallback for one planet. Each rule is the new look's only, so each has the same walk with the switch off, where the
 * old look's behaviour must hold.
 */

/** The one planet whose world cannot be drawn in these tests (the fixture's CI planet 2 has this seed). */
const mockRefusedSeed = 'b'.repeat(32);
jest.mock('@knowscroll/scene-core', () => {
  const actual = jest.requireActual<typeof SceneCore>('@knowscroll/scene-core');
  return {
    ...actual,
    buildGlobe: (spec: Parameters<typeof actual.buildGlobe>[0]) => {
      if (mockRefuse && spec.seed === mockRefusedSeed) throw new Error('world_refused');
      return actual.buildGlobe(spec);
    },
  };
});
let mockRefuse = false;
jest.mock('../../platform/device-preferences-store', () => ({
  devicePreferencesStore: { read: () => null, write: () => undefined },
}));
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
jest.mock('./voyage/voyage-loader', () => ({
  loadVoyageRenderer: () => () => jest.requireActual<typeof FakeGpu>('./space/fake-space-gpu').fakeGpu.load(),
}));
jest.mock('../../providers/account-scope', () => ({
  useAccountScope: () => ({ state: { status: 'signed_in', scope: mockScope } }),
  useAccountInitial: () => 'F',
}));
jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof React>('react');
  return {
    useFocusEffect: (effect: EffectCallback) => useEffect(effect, [effect]),
    useIsFocused: () => true,
    useRouter: () => ({ navigate: jest.fn(), push: jest.fn(), canGoBack: () => false }),
    useLocalSearchParams: () => ({}),
  };
});
jest.mock('expo-status-bar', () => ({ setStatusBarStyle: jest.fn() }));
beforeEach(() => {
  mockRefuse = false;
  resetFakeGpu();
  Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true });
});

const screenWith = (trial: boolean) => (
  <DevicePreferencesProvider initial={{ ...defaultDevicePreferences, universeTrial: trial }}>
    <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
      <UniverseScreen />
    </DisplayProvider>
  </DevicePreferencesProvider>
);

const SYSTEM = { name: 'CI system 0, a system' } as const;
const PLANET = { name: 'CI planet 2, a planet' } as const;

async function open(trial: boolean, harness = universeHarness()) {
  mockScope = harness.scope;
  const view = await render(screenWith(trial));
  await waitFor(() => expect(screen.getByRole('button', SYSTEM)).toBeOnTheScreen());
  return {
    harness,
    close: async () => {
      await act(() => harness.scope.end());
      await view.unmount();
    },
  };
}

describe('the List view chip', () => {
  it('has a dark glass fill in the new look, so it reads over pale land', async () => {
    const { close } = await open(true);
    expect(screen.getByTestId('universe-list')).toHaveStyle({ backgroundColor: 'rgba(10,20,28,0.55)' });
    await fireEvent.press(screen.getByRole('button', SYSTEM));
    await fireEvent.press(screen.getByRole('button', PLANET));
    expect(screen.getByTestId('universe-list')).toHaveStyle({ backgroundColor: 'rgba(10,20,28,0.55)' });
    await close();
  });

  it('is the ghost chip it was with the switch off: a hairline, no fill', async () => {
    const { close } = await open(false);
    for (const step of [null, SYSTEM, PLANET]) {
      if (step) await fireEvent.press(screen.getByRole('button', step));
      const chip = screen.getByTestId('universe-list');
      expect(chip).not.toHaveStyle({ backgroundColor: 'rgba(10,20,28,0.55)' });
      expect(chip).toHaveStyle({ borderWidth: 1 });
    }
    await close();
  });
});

describe('Return to the planet you left', () => {
  it('is not offered at its star after Back, and is at the whole universe, in the new look', async () => {
    const { close } = await open(true);
    await fireEvent.press(screen.getByRole('button', SYSTEM));
    await fireEvent.press(screen.getByRole('button', PLANET));
    // On the globe the ship is where you are: no chip.
    expect(screen.queryByTestId('universe-return')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Back to CI system 0' }));
    expect(screen.getByRole('header', { name: 'CI system 0' })).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Return to CI planet 2' })).toBeNull();
    // The other chips of the stop are still there.
    expect(screen.getByTestId('universe-list')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Back to Universe' }));
    expect(screen.getByRole('button', { name: 'Return to CI planet 2' })).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Return to CI planet 2' }));
    expect(screen.getByRole('header', { name: 'CI planet 2' })).toBeOnTheScreen();
    await close();
  });

  it('is as it was with the switch off: only at the whole universe', async () => {
    const { close } = await open(false);
    await fireEvent.press(screen.getByRole('button', SYSTEM));
    await fireEvent.press(screen.getByRole('button', PLANET));
    await fireEvent.press(screen.getByRole('button', { name: 'Back to CI system 0' }));
    expect(screen.queryByTestId('universe-return')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Back to Universe' }));
    expect(screen.getByRole('button', { name: 'Return to CI planet 2' })).toBeOnTheScreen();
    await close();
  });
});

describe('Lately calms the written names of quiet systems', () => {
  const quietSystem = () => {
    const harness = universeHarness();
    const place = harness.world.descriptors.find((descriptor) => descriptor.kind === 'system')!;
    place.activity = { availability: 'available', state: 'quiet' };
    return harness;
  };

  // Under Lately the names of quiet systems dim in both looks (`calm` on the labels).
  it.each([[true], [false]])(
    'with the new look %s, a quiet system’s name dims to 0.7 only while Lately is on',
    async (trial) => {
      const { close } = await open(trial, quietSystem());
      await waitFor(() => expect(screen.getByText('CI system 0')).toBeOnTheScreen());
      expect(screen.getByText('CI system 0')).toHaveStyle({ color: space.label });
      await fireEvent.press(screen.getByRole('togglebutton', { name: 'Lately' }));
      await waitFor(() => expect(screen.getByText('CI system 0')).toHaveStyle({ color: space.label2 }));
      await fireEvent.press(screen.getByRole('togglebutton', { name: 'Lately' }));
      await waitFor(() => expect(screen.getByText('CI system 0')).toHaveStyle({ color: space.label }));
      await close();
    },
  );

  it('leaves the names of active systems alone, Lately on or off', async () => {
    const { close } = await open(true);
    await fireEvent.press(screen.getByRole('togglebutton', { name: 'Lately' }));
    expect(screen.getByText('CI system 0')).toHaveStyle({ color: space.label });
    await close();
  });
});

describe('one planet whose world cannot be drawn', () => {
  it('shows that planet as the plain list in the new look, as the old look does', async () => {
    for (const trial of [true, false]) {
      mockRefuse = true;
      const { close } = await open(trial);
      await fireEvent.press(screen.getByRole('button', SYSTEM));
      await fireEvent.press(screen.getByRole('button', PLANET));
      await waitFor(() => expect(screen.getByTestId('universe-simple')).toBeOnTheScreen());
      expect(screen.queryByTestId('universe-dial')).toBeNull();
      await close();
    }
  });

  it('leaves a planet that draws alone in the new look', async () => {
    mockRefuse = true;
    const { close } = await open(true);
    await fireEvent.press(screen.getByRole('button', SYSTEM));
    await fireEvent.press(screen.getByRole('button', { name: 'CI planet 3, a planet' }));
    await waitFor(() => expect(screen.getByRole('header', { name: 'CI planet 3' })).toBeOnTheScreen());
    expect(screen.queryByTestId('universe-simple')).toBeNull();
    expect(screen.getByTestId('voyage-stage')).toBeOnTheScreen();
    await close();
  });
});
