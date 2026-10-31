import type * as React from 'react';
import type * as FakeGpu from '../space/fake-space-gpu';
import { type EffectCallback } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { AppState } from 'react-native';
import { DisplayProvider } from '@knowscroll/ui';
import type { AccountScope } from '@knowscroll/client-core';
import { UniverseScreen } from '../universe-screen';
import { fakeGpu, resetFakeGpu } from '../space/fake-space-gpu';
import { sceneFixture, universeHarness } from '../universe.fixture';
import { indexUniverse, viewFor } from '../universe-layout';
import { looksById } from '../space/space-model';
import { universeSessionFor } from '../use-universe-session';
import { stepBetween } from './use-universe-animation';

let mockScope: AccountScope;
jest.mock('../../../platform/command-id', () => {
  let next = 30000;
  return { newCommandId: () => `0199a000-0000-7000-8000-${(next++).toString(16).padStart(12, '0')}` };
});
// The real stage, loop, overlay and animation over a stand-in for the GPU (no WebGL claimed; the browser
// spec e2e/universe-animations-smoke.spec.ts draws for real).
jest.mock('../space/space-canvas', () => ({
  SpaceCanvas: jest.requireActual<typeof FakeGpu>('../space/fake-space-gpu').fakeGpu.Canvas,
}));
jest.mock('../space/load-space-renderer', () => ({
  loadSpaceRenderer: () => jest.requireActual<typeof FakeGpu>('../space/fake-space-gpu').fakeGpu.load(),
  loadFirstOpenRenderer: () => () => jest.requireActual<typeof FakeGpu>('../space/fake-space-gpu').fakeGpu.load(),
}));
jest.mock('../../../providers/account-scope', () => ({
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

/** Frames the test hands out by hand, so an animation is walked at stamps it chooses, as `requestAnimationFrame` would. */
let waiting: ((nowMs: number) => void)[] = [];
let stamp = 10_000;
beforeEach(() => {
  resetFakeGpu();
  waiting = [];
  stamp = 10_000;
  jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
    waiting.push(callback);
    return waiting.length;
  });
  jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined);
  Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true });
});
afterEach(() => jest.restoreAllMocks());

/** Plays `seconds` of frames, at 60 Hz unless a longer step is asked for (a frame never moves `t` by more than 0.1 s). */
async function playFor(seconds: number, stepMs = 1000 / 60): Promise<void> {
  const until = stamp + seconds * 1000;
  while (stamp < until) {
    stamp += stepMs;
    const frames = waiting.splice(0);
    await act(() => frames.forEach((frame) => frame(stamp)));
  }
}

const withMotion = (
  <DisplayProvider value={{ width: 750, textScale: 1, reducedMotion: false }}>
    <UniverseScreen />
  </DisplayProvider>
);
const calm = (
  <DisplayProvider value={{ width: 750, textScale: 1, reducedMotion: true }}>
    <UniverseScreen />
  </DisplayProvider>
);

/** Waits for something to show, handing out frames meanwhile: the map is drawn by the renderer's loop. */
const settle = (check: () => void) =>
  waitFor(async () => {
    await playFor(0.05);
    check();
  });

/** The animation's layers are decoration, hidden from assistive technology by design. */
const hidden = { includeHiddenElements: true } as const;

const system = () => screen.getByRole('button', { name: 'CI system 0, a system' });
const lastScript = () => fakeGpu.renderers.at(-1)!.scripts.at(-1);

async function openUniverse(node: React.ReactElement, first?: boolean) {
  const h = universeHarness();
  if (first !== undefined) h.firstOpen(first);
  mockScope = h.scope;
  const view = await render(node);
  await settle(() => expect(system()).toBeOnTheScreen());
  return { h, view };
}

describe('the step a change of view is', () => {
  const world = sceneFixture(5);
  const index = indexUniverse(world.descriptors, []);
  const looks = looksById(world.looks);
  const [systemPlace] = index.systems;
  const planet = index.planets.get(systemPlace!.objectId)![0]!;
  const universe = viewFor(index, null);
  const inSystem = viewFor(index, systemPlace!.objectId);
  const onGlobe = viewFor(index, planet.objectId, false);
  const landed = viewFor(index, planet.objectId, true);

  it('animates the single step down and the single step up, and nothing longer', () => {
    expect(stepBetween(universe, inSystem, looks)?.kind).toBe('enter-system');
    expect(stepBetween(inSystem, onGlobe, looks)?.kind).toMatch(/^enter-planet/);
    expect(stepBetween(onGlobe, landed, looks)?.kind).toBe('enter-world');
    // Every step up is a 0.3 s cross-fade (D-093).
    expect(stepBetween(inSystem, universe, looks)?.kind).toBe('step-up');
    expect(stepBetween(onGlobe, inSystem, looks)?.kind).toBe('step-up');
    expect(stepBetween(landed, onGlobe, looks)?.kind).toBe('step-up');
    // A long jump, up or down, goes straight to its destination.
    expect(stepBetween(universe, onGlobe, looks)).toBeUndefined();
    expect(stepBetween(universe, landed, looks)).toBeUndefined();
    expect(stepBetween(onGlobe, universe, looks)).toBeUndefined();
    expect(stepBetween(landed, inSystem, looks)).toBeUndefined();
  });

  it('plays the ringed version only for a planet that has rings or a moon', () => {
    const plain = new Map([[planet.objectId, { ...looks.get(planet.objectId)!, rings: false, moon: false }]]);
    expect(stepBetween(inSystem, onGlobe, plain as never)?.kind).toBe('enter-planet');
    const ringed = new Map([[planet.objectId, { ...looks.get(planet.objectId)!, rings: true, moon: false }]]);
    expect(stepBetween(inSystem, onGlobe, ringed as never)?.kind).toBe('enter-planet-rings');
    const mooned = new Map([[planet.objectId, { ...looks.get(planet.objectId)!, rings: false, moon: true }]]);
    expect(stepBetween(inSystem, onGlobe, mooned as never)?.kind).toBe('enter-planet-rings');
  });
});

describe('entering a system', () => {
  it('gives the renderer the camera for 5.3 s, ignores taps meanwhile, and hands back the live view', async () => {
    const { view } = await openUniverse(withMotion);
    await fireEvent.press(system());
    await settle(() => expect(lastScript()?.kind).toBe('enter-system'));
    expect(screen.getByTestId('universe-tap-ring', hidden)).toBeOnTheScreen();
    // A tap on a planet while it plays does nothing: the system is still the screen.
    await fireEvent.press(screen.getByRole('button', { name: 'CI planet 2, a planet' }));
    await playFor(1);
    expect(screen.getByRole('button', { name: 'Back to Universe' })).toBeOnTheScreen();
    expect(screen.queryByTestId('universe-land')).toBeNull();
    expect(lastScript()?.kind).toBe('enter-system');
    await playFor(5);
    expect(lastScript()).toBeNull();
    expect(screen.queryByTestId('universe-tap-ring', hidden)).toBeNull();
    // After it, taps work again.
    await fireEvent.press(screen.getByRole('button', { name: 'CI planet 2, a planet' }));
    await settle(() => expect(screen.getByRole('button', { name: 'Back to CI system 0' })).toBeOnTheScreen());
    await view.unmount();
  });

  it('jumps to the end frame on Back and then goes back as normal', async () => {
    const { view } = await openUniverse(withMotion);
    await fireEvent.press(system());
    await settle(() => expect(lastScript()?.kind).toBe('enter-system'));
    await playFor(0.5);
    await fireEvent.press(screen.getByRole('button', { name: 'Back to Universe' }));
    await settle(() => expect(lastScript()).toBeNull());
    await settle(() => expect(screen.getByRole('header', { name: 'Your universe' })).toBeOnTheScreen());
    expect(screen.queryByTestId('universe-tap-ring', hidden)).toBeNull();
    await view.unmount();
  });

  it('plays nothing under reduced motion: the system is shown at once', async () => {
    const { view } = await openUniverse(calm);
    await fireEvent.press(system());
    await settle(() => expect(screen.getByRole('button', { name: 'Back to Universe' })).toBeOnTheScreen());
    expect(fakeGpu.renderers.at(-1)!.scripts.every((script) => script === null)).toBe(true);
    expect(screen.queryByTestId('universe-tap-ring', hidden)).toBeNull();
    await view.unmount();
  });
});

describe('entering a planet', () => {
  async function toPlanet() {
    const opened = await openUniverse(withMotion);
    await fireEvent.press(system());
    await settle(() => expect(lastScript()?.kind).toBe('enter-system'));
    await playFor(6);
    await fireEvent.press(screen.getByRole('button', { name: 'CI planet 2, a planet' }));
    return opened;
  }

  it('glides the 3D camera down with the globe laid over the planet, ringed planets turning their ring and moon', async () => {
    const { view } = await toPlanet();
    await settle(() => expect(lastScript()?.kind).toBe('enter-planet'));
    // CI planet 2 has rings: the 3D ring and moon are turned into the planet view's on the way in.
    expect(lastScript()?.planetId).toBeDefined();
    expect(lastScript()?.ringed).toBe(true);
    expect(screen.getByTestId('universe-globe-layer', hidden)).toBeOnTheScreen();
    // The 3D scene is its own layer, which fades out over the last of the glide so the last frame is the planet view's sky.
    expect(screen.getByTestId('universe-3d-layer', hidden)).toBeOnTheScreen();
    expect(screen.getByTestId('universe-tap-ring', hidden)).toBeOnTheScreen();
    // The tab bar is not the screen's and the planet's chrome is not drawn as the finished screen yet.
    await playFor(4.5);
    expect(screen.queryByTestId('universe-globe-layer', hidden)).toBeNull();
    await settle(() => expect(screen.getByRole('button', { name: 'Land on CI planet 2' })).toBeOnTheScreen());
    expect(screen.getByText('Drag to rotate · tap to land')).toBeOnTheScreen();
    await view.unmount();
  });
});

describe('entering a world', () => {
  it('flattens the globe into the map and lands on it, ignoring taps while it moves', async () => {
    const { view } = await openUniverse(withMotion);
    await fireEvent.press(system());
    await playFor(6);
    await fireEvent.press(screen.getByRole('button', { name: 'CI planet 2, a planet' }));
    await playFor(5);
    await settle(() => expect(screen.getByRole('button', { name: 'Land on CI planet 2' })).toBeOnTheScreen());
    await fireEvent.press(screen.getByRole('button', { name: 'Land on CI planet 2' }));
    await settle(() => expect(screen.getByTestId('universe-world-layers', hidden)).toBeOnTheScreen());
    // A second tap while it plays is ignored: the session's gate is closed.
    expect(universeSessionFor(mockScope).land()).toBe(false);
    await playFor(3.6);
    expect(screen.queryByTestId('universe-world-layers', hidden)).toBeNull();
    await settle(() => expect(screen.getByRole('button', { name: 'CI region 4, a region' })).toBeOnTheScreen());
    await view.unmount();
  });
});

describe('going back up', () => {
  it('is a 0.3 s cross-fade that ignores taps meanwhile, for a system to the whole map', async () => {
    const { view } = await openUniverse(withMotion);
    await fireEvent.press(system());
    await playFor(6);
    await fireEvent.press(screen.getByRole('button', { name: 'Back to Universe' }));
    await settle(() => expect(screen.getByRole('header', { name: 'Your universe' })).toBeOnTheScreen());
    // The system's chrome is still on screen, fading, and the gate is closed.
    expect(screen.getByRole('header', { name: 'CI system 0', ...hidden })).toBeOnTheScreen();
    expect(universeSessionFor(mockScope).focus('x')).toBe(false);
    await playFor(0.5);
    expect(screen.queryByRole('header', { name: 'CI system 0', ...hidden })).toBeNull();
    await view.unmount();
  });

  it('lays the planet being left over the system being entered while it fades', async () => {
    const { view } = await openUniverse(withMotion);
    await fireEvent.press(system());
    await playFor(6);
    await fireEvent.press(screen.getByRole('button', { name: 'CI planet 2, a planet' }));
    await playFor(5);
    await settle(() => expect(screen.getByRole('button', { name: 'Back to CI system 0' })).toBeOnTheScreen());
    await fireEvent.press(screen.getByRole('button', { name: 'Back to CI system 0' }));
    await settle(() => expect(screen.getByTestId('universe-leaving-layer', hidden)).toBeOnTheScreen());
    await playFor(0.5);
    expect(screen.queryByTestId('universe-leaving-layer', hidden)).toBeNull();
    await view.unmount();
  });
});

describe('the first open', () => {
  it('plays once when the account has not seen it, claims it only once its picture can be drawn, and shows the tab when it ends', async () => {
    const h = universeHarness();
    h.firstOpen(true);
    mockScope = h.scope;
    const view = await render(withMotion);
    await settle(() => expect(screen.getByTestId('first-open')).toBeOnTheScreen());
    expect(h.calls.filter((path) => path === '/v1/account/universe/first-open')).toHaveLength(1);
    // Skip is always there and counts as seen.
    expect(screen.getByRole('button', { name: 'Skip the opening' })).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Skip the opening' }));
    await settle(() => expect(screen.queryByTestId('first-open')).toBeNull());
    await settle(() => expect(system()).toBeOnTheScreen());
    await view.unmount();
    // Opened again on this device, the claim is not made again and nothing plays.
    const again = await render(withMotion);
    await settle(() => expect(system()).toBeOnTheScreen());
    expect(screen.queryByTestId('first-open')).toBeNull();
    expect(h.calls.filter((path) => path === '/v1/account/universe/first-open')).toHaveLength(1);
    await again.unmount();
  });

  it('is not asked for again on this device once the account has said it was seen', async () => {
    const h = universeHarness();
    h.firstOpen(false);
    mockScope = h.scope;
    const first = await render(withMotion);
    await settle(() => expect(system()).toBeOnTheScreen());
    await first.unmount();
    const rendersBefore = fakeGpu.renderers.length;
    const second = await render(withMotion);
    await settle(() => expect(system()).toBeOnTheScreen());
    // No second claim and no picture was even built: the tab opened at once.
    expect(h.calls.filter((path) => path === '/v1/account/universe/first-open')).toHaveLength(1);
    expect(fakeGpu.renderers.length - rendersBefore).toBe(1);
    await second.unmount();
  });

  it('leaves the account\u2019s one opening alone when the picture cannot get a WebGL context', async () => {
    const h = universeHarness();
    h.firstOpen(true);
    mockScope = h.scope;
    fakeGpu.failToCreate = true;
    const view = await render(withMotion);
    // The map\u2019s own renderer fails too, so the tab is the Simple lists: what matters is that nothing was claimed.
    await settle(() => expect(screen.queryByTestId('first-open-preparing')).toBeNull());
    expect(h.calls).not.toContain('/v1/account/universe/first-open');
    await view.unmount();
  });

  it('keeps the real screen and its 3D canvas through the handover: it is not built again when the picture goes (account with places)', async () => {
    const h = universeHarness();
    h.firstOpen(true);
    mockScope = h.scope;
    const view = await render(withMotion);
    await settle(() => expect(screen.getByTestId('first-open')).toBeOnTheScreen());
    // Until 19 s the real screen is not drawn at all: one 3D scene, the picture.
    expect(fakeGpu.renderers).toHaveLength(1);
    await playFor(19.3, 100);
    await settle(() => expect(fakeGpu.renderers).toHaveLength(2));
    const map = fakeGpu.renderers[1]!;
    await playFor(1.5, 100);
    await settle(() => expect(screen.queryByTestId('first-open')).toBeNull());
    // The picture\u2019s scene is gone; the map\u2019s is the one that was drawing beneath it, untouched.
    expect(fakeGpu.renderers).toHaveLength(2);
    expect(fakeGpu.renderers[0]!.disposed).toBe(true);
    expect(map.disposed).toBe(false);
    expect(system()).toBeOnTheScreen();
    await view.unmount();
  });

  it('keeps the empty screen and its sky through the handover too (account with no places)', async () => {
    const h = universeHarness(0);
    h.firstOpen(true);
    mockScope = h.scope;
    const view = await render(withMotion);
    await settle(() => expect(screen.getByTestId('first-open')).toBeOnTheScreen());
    await playFor(19.5, 100);
    await settle(() => expect(fakeGpu.renderers).toHaveLength(2));
    const sky = fakeGpu.renderers[1]!;
    await playFor(2.2, 100);
    await settle(() => expect(screen.queryByTestId('first-open')).toBeNull());
    expect(fakeGpu.renderers).toHaveLength(2);
    expect(sky.disposed).toBe(false);
    expect(screen.getByText('Your universe starts quiet.')).toBeOnTheScreen();
    await view.unmount();
  });

  it('does not play when the account has seen it, on this or any other device', async () => {
    const { h, view } = await openUniverse(withMotion, false);
    expect(screen.queryByTestId('first-open')).toBeNull();
    expect(h.calls.filter((path) => path === '/v1/account/universe/first-open')).toHaveLength(1);
    await view.unmount();
  });

  it('does not play, and does not use up the account\u2019s one opening, under reduced motion', async () => {
    const { h, view } = await openUniverse(calm, true);
    expect(screen.queryByTestId('first-open')).toBeNull();
    expect(h.calls).not.toContain('/v1/account/universe/first-open');
    await view.unmount();
  });
});
