import type * as React from 'react';
import type * as FakeGpu from '../space/fake-space-gpu';
import { type EffectCallback } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { AppState } from 'react-native';
import type { AccountScope } from '@knowscroll/client-core';
import { DisplayProvider } from '@knowscroll/ui';
import { UniverseScreen } from '../universe-screen';
import { UniverseSurface } from '../universe-surface';
import { indexUniverse } from '../universe-layout';
import { descriptorsOf } from '../universe-places';
import { resetFakeGpu } from '../space/fake-space-gpu';
import { COLLECTION_READS, fixtureId, universeHarness } from '../universe.fixture';
import { universeSessionFor } from '../use-universe-session';
import { WAITING_NOTE } from './collection-parts';
import { writeSeenLandmark } from './landmark-seen';

/**
 * The person's collection on the Universe (v3 S-4, D-084, D-087, D-089, D-214, D-215): the tray, the sheet, the
 * painted markers, the Orbit as text and the resume chip, over the real session and screen with a stand-in for
 * the GPU. Authored fixtures only; no landmark here was earned by anyone.
 */
let mockScope: AccountScope;
jest.mock('../../../platform/command-id', () => {
  let next = 30000;
  return { newCommandId: () => `0199a000-0000-7000-8000-${(next++).toString(16).padStart(12, '0')}` };
});
jest.mock('../space/space-canvas', () => ({
  SpaceCanvas: jest.requireActual<typeof FakeGpu>('../space/fake-space-gpu').fakeGpu.Canvas,
}));
jest.mock('../space/load-space-renderer', () => ({
  loadSpaceRenderer: () => jest.requireActual<typeof FakeGpu>('../space/fake-space-gpu').fakeGpu.load(),
}));
const mockNavigate = jest.fn();
const mockPush = jest.fn();
jest.mock('../../../providers/account-scope', () => ({
  useAccountScope: () => ({ state: { status: 'signed_in', scope: mockScope } }),
  useAccountInitial: () => 'F',
}));
jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof React>('react');
  return {
    useFocusEffect: (effect: EffectCallback) => useEffect(effect, [effect]),
    useIsFocused: () => true,
    useRouter: () => ({ navigate: mockNavigate, push: mockPush, canGoBack: () => false }),
    useLocalSearchParams: () => ({}),
  };
});
jest.mock('expo-status-bar', () => ({ setStatusBarStyle: jest.fn() }));
beforeEach(() => {
  resetFakeGpu();
  mockNavigate.mockReset();
  mockPush.mockReset();
  Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true });
});

/** A landmark as the server lists it: gold for the Seasons Scroll, on the topic that names its planet. */
const earned = (over: Record<string, unknown> = {}) => ({
  key: 'the-leaning-axis',
  name: 'The Leaning Axis',
  tier: 'gold',
  assetId: fixtureId(500),
  revision: 1,
  // Earned now: the card calls a landmark new for a week, so a fixed date would age out of this test.
  earnedAt: new Date().toISOString(),
  topicId: 'earth.seasons',
  ...over,
});
const universeRead = (path: string) =>
  path.startsWith('/v1/universe/') || path === '/v1/rooms/stations' || COLLECTION_READS.includes(path);

async function open(h: ReturnType<typeof universeHarness>) {
  mockScope = h.scope;
  // The steps down have animations of their own (animation/step-animations.test.tsx); these tests walk the map and skip them.
  const view = await render(
    <DisplayProvider value={{ width: 750, textScale: 1, reducedMotion: true }}>
      <UniverseScreen />
    </DisplayProvider>,
  );
  await waitFor(() => expect(screen.getByRole('button', { name: 'CI system 0, a system' })).toBeOnTheScreen());
  return view;
}

/** Every string a screen draws, hidden or not. */
function allStrings(node: unknown, found: string[] = []): string[] {
  if (typeof node === 'string') found.push(node);
  else if (Array.isArray(node)) for (const child of node) allStrings(child, found);
  else if (node && typeof node === 'object') allStrings((node as { children?: unknown }).children, found);
  return found;
}

it('says a landmark is new while its planet has not formed, with the Orbit as text, on a paper card', async () => {
  const h = universeHarness();
  h.world.collection.landmarks = [earned()];
  h.world.collection.orbit = { days: 1, goal: 3, weekStart: '2026-11-02', closed: false };
  const v = await open(h);
  await waitFor(() => expect(screen.getByTestId('universe-landmark-card')).toBeOnTheScreen());
  expect(screen.getByText('New landmark')).toBeOnTheScreen();
  expect(screen.getByText('The Leaning Axis')).toBeOnTheScreen();
  expect(screen.getByText('Gold finish · waits for its planet')).toBeOnTheScreen();
  expect(screen.getByTestId('universe-orbit')).toHaveTextContent('Orbit · 1 of 3 days this week');
  // The map itself carries no chip of the collection (the Universe set draws none): the card is not folded here.
  expect(screen.queryByTestId('universe-landmark-chip')).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'See it, your landmarks' }));
  expect(await screen.findByTestId('universe-collection-sheet')).toBeOnTheScreen();
  expect(screen.getByText('Gold finish · Waiting for its planet')).toBeOnTheScreen();
  // A landmark that waits has no place on the map, and the list says so instead of drawing one (#694).
  expect(screen.getByTestId('universe-landmark-waiting-note')).toHaveTextContent(WAITING_NOTE);
  expect(
    screen.getByText('Missed a week? Nothing here goes away. Orbits just start fresh on Monday.'),
  ).toBeOnTheScreen();
  // Reading the collection only reads.
  expect(h.calls.every(universeRead)).toBe(true);
  await act(() => h.scope.end());
  await v.unmount();
});

it('puts the large card away after See it: closing the list leaves the one-line pill, which opens the list again (#694)', async () => {
  const h = universeHarness();
  h.world.collection.landmarks = [earned()];
  const v = await open(h);
  await fireEvent.press(await screen.findByRole('button', { name: 'See it, your landmarks' }));
  await fireEvent.press(await screen.findByRole('button', { name: 'Close landmarks' }));
  expect(screen.queryByTestId('universe-landmark-card')).toBeNull();
  expect(screen.getByTestId('universe-landmark-chip')).toHaveTextContent('New landmark · The Leaning Axis');
  await fireEvent.press(screen.getByTestId('universe-landmark-chip'));
  expect(await screen.findByTestId('universe-collection-sheet')).toBeOnTheScreen();
  // Remembered on this device for the account only, and never sent anywhere.
  expect(h.scope.storage.get('universe.landmark-seen.v1')).toBe(JSON.stringify({ landmarkId: `${fixtureId(500)}:1` }));
  expect(h.calls.every(universeRead)).toBe(true);
  await act(() => h.scope.end());
  await v.unmount();
});

it('closes the large card with its own button, keeps it folded on the next visit, and opens it for a newer landmark (#694)', async () => {
  const h = universeHarness();
  h.world.collection.landmarks = [earned()];
  const v = await open(h);
  await fireEvent.press(await screen.findByRole('button', { name: 'Close landmark card' }));
  expect(screen.queryByTestId('universe-landmark-card')).toBeNull();
  expect(screen.getByTestId('universe-landmark-chip')).toBeOnTheScreen();
  await v.unmount();
  // Back on the Universe later (a reload reads the same device storage): still folded for the same landmark.
  const again = await open(h);
  await waitFor(() => expect(screen.getByTestId('universe-landmark-chip')).toBeOnTheScreen());
  expect(screen.queryByTestId('universe-landmark-card')).toBeNull();
  await again.unmount();
  await act(() => h.scope.end());
  // A newer landmark is a new event: its card opens in full.
  const next = universeHarness();
  writeSeenLandmark(next.scope, `${fixtureId(500)}:1`);
  next.world.collection.landmarks = [
    earned({ key: 'the-turning-halves', name: 'The Turning Halves', assetId: fixtureId(501) }),
    earned(),
  ];
  const later = await open(next);
  await waitFor(() => expect(screen.getByTestId('universe-landmark-card')).toBeOnTheScreen());
  expect(screen.getByText('The Turning Halves')).toBeOnTheScreen();
  await act(() => next.scope.end());
  await later.unmount();
});

it('See it flies to the planet a landmark stands on, where the globe paints its pennant (#694)', async () => {
  const h = universeHarness();
  h.world.collection.landmarks = [earned()];
  h.world.collection.planets = [{ id: fixtureId(12), topicId: 'earth.seasons' }];
  const v = await open(h);
  await fireEvent.press(await screen.findByRole('button', { name: 'See it on CI planet 2' }));
  expect(screen.queryByTestId('universe-collection-sheet')).toBeNull();
  expect(await screen.findByRole('header', { name: 'CI planet 2' })).toBeOnTheScreen();
  await waitFor(() =>
    expect(screen.getAllByTestId('landmark-mark-gold', { includeHiddenElements: true }).length).toBeGreaterThan(0),
  );
  expect(screen.getByTestId('universe-landmark-chip')).toHaveTextContent('New landmark · The Leaning Axis');
  expect(h.calls.every(universeRead)).toBe(true);
  await act(() => h.scope.end());
  await v.unmount();
});

it('lets a long landmark name wrap to three lines and its waiting line to two, never cut after one (#648)', async () => {
  const h = universeHarness();
  h.world.collection.landmarks = [earned({ name: 'The Returning Glow' })];
  const v = await open(h);
  await waitFor(() => expect(screen.getByTestId('universe-landmark-card')).toBeOnTheScreen());
  expect(screen.getByTestId('universe-landmark-title').props.numberOfLines).toBe(3);
  expect(screen.getByTestId('universe-landmark-line').props.numberOfLines).toBe(2);
  await act(() => h.scope.end());
  await v.unmount();
});

it('calls a landmark new for a week and the latest after, and has no See it on a week with no landmark', async () => {
  const h = universeHarness();
  h.world.collection.landmarks = [earned({ earnedAt: '2026-01-02T10:00:00.000Z' })];
  const old = await open(h);
  await waitFor(() => expect(screen.getByTestId('universe-landmark-card')).toBeOnTheScreen());
  expect(screen.getByText('Latest landmark')).toBeOnTheScreen();
  expect(screen.queryByText('New landmark')).toBeNull();
  await act(() => h.scope.end());
  await old.unmount();
  // Only the week to say: the card has nothing to open, so it offers no button that promises landmarks.
  const quiet = universeHarness();
  quiet.world.collection.orbit = { days: 1, goal: 3, weekStart: '2026-11-02', closed: false };
  const week = await open(quiet);
  await waitFor(() => expect(screen.getByTestId('universe-landmark-card')).toBeOnTheScreen());
  expect(screen.getByText('This week')).toBeOnTheScreen();
  expect(screen.queryByRole('button', { name: /landmarks/i })).toBeNull();
  await act(() => quiet.scope.end());
  await week.unmount();
});

it('stands the landmark on its planet once that planet has formed: nothing waits, and the globe paints it', async () => {
  const h = universeHarness();
  h.world.collection.landmarks = [
    earned(),
    earned({ key: 'the-turning-halves', name: 'The Turning Halves', tier: 'plain', assetId: fixtureId(501) }),
  ];
  h.world.collection.planets = [{ id: fixtureId(12), topicId: 'earth.seasons' }];
  const v = await open(h);
  await waitFor(() => expect(screen.getByTestId('universe-landmark-card')).toBeOnTheScreen());
  expect(screen.getByText('from CI planet 2 · gold finish')).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: 'CI system 0, a system' }));
  await fireEvent.press(screen.getByRole('button', { name: 'CI planet 2, a planet' }));
  // With a globe on screen the card is one line, so it cannot cover the planet's name or hint.
  expect(screen.queryByTestId('universe-landmark-card')).toBeNull();
  expect(screen.getByTestId('universe-landmark-chip')).toHaveTextContent('New landmark · The Leaning Axis');
  // The globe paints a pennant for each landmark, gold or plain.
  await waitFor(() =>
    expect(screen.getAllByTestId('landmark-mark-gold', { includeHiddenElements: true }).length).toBeGreaterThan(0),
  );
  expect(screen.getAllByTestId('landmark-mark-plain', { includeHiddenElements: true }).length).toBeGreaterThan(0);
  // The list says where each one stands, for a screen reader and for anyone who cannot see the drawing.
  await fireEvent.press(screen.getByTestId('universe-landmark-chip'));
  expect(await screen.findByText('Gold finish · On CI planet 2')).toBeOnTheScreen();
  expect(screen.getByText('Plain finish · On CI planet 2')).toBeOnTheScreen();
  await act(() => h.scope.end());
  await v.unmount();
});

it('paints no marker on a planet that is not the landmark’s, and keeps the landmark waiting', async () => {
  const h = universeHarness();
  h.world.collection.landmarks = [earned()];
  // Another topic's planet: nothing here names the Seasons planet yet.
  h.world.collection.planets = [{ id: fixtureId(13), topicId: 'earth.tides' }];
  const v = await open(h);
  await waitFor(() => expect(screen.getByText('Gold finish · waits for its planet')).toBeOnTheScreen());
  await fireEvent.press(screen.getByRole('button', { name: 'CI system 0, a system' }));
  await fireEvent.press(screen.getByRole('button', { name: 'CI planet 2, a planet' }));
  expect(screen.queryAllByTestId('landmark-mark-gold', { includeHiddenElements: true })).toHaveLength(0);
  await act(() => h.scope.end());
  await v.unmount();
});

it('offers the next Part to resume and opens it by its address', async () => {
  const h = universeHarness();
  h.world.collection.resume = { assetId: fixtureId(502), title: 'Why the hemispheres take turns', part: 2, total: 3 };
  const v = await open(h);
  // With no landmark yet the card speaks of the next Part, with its own Resume.
  expect(await screen.findByText('Next part')).toBeOnTheScreen();
  expect(screen.getByText('Part 2 of 3')).toBeOnTheScreen();
  const chip = await screen.findByRole('button', { name: 'Resume Part 2 of 3: Why the hemispheres take turns' });
  await fireEvent.press(chip);
  expect(mockPush).toHaveBeenCalledWith({ pathname: '/scroll/[assetId]', params: { assetId: fixtureId(502) } });
  await act(() => h.scope.end());
  await v.unmount();
});

it('is quiet before anything was played: no card, no resume, no Orbit line, no score words', async () => {
  const h = universeHarness();
  const v = await open(h);
  await waitFor(() => expect(h.calls).toContain('/v1/experience/resume/read'));
  await waitFor(() => expect(h.calls).toContain('/v1/play/orbit/read'));
  expect(screen.queryByTestId('universe-resume')).toBeNull();
  expect(screen.queryByTestId('universe-orbit')).toBeNull();
  expect(screen.queryByTestId('universe-landmark-card')).toBeNull();
  expect(screen.queryByTestId('universe-landmark-chip')).toBeNull();
  expect(allStrings(screen.toJSON()).join(' | ')).not.toMatch(/streak|lose|lost|missed|score|level|rank/i);
  await act(() => h.scope.end());
  await v.unmount();
});

it('lists the landmarks and the Orbit in the Simple drawing too, in plain words', async () => {
  const h = universeHarness();
  h.world.collection.landmarks = [earned()];
  h.world.collection.orbit = { days: 2, goal: 3, weekStart: '2026-11-02', closed: false };
  const v = await open(h);
  await waitFor(() => expect(screen.getByTestId('universe-landmark-card')).toBeOnTheScreen());
  await fireEvent.press(screen.getByRole('button', { name: 'List view' }));
  await fireEvent.press(screen.getByRole('togglebutton', { name: 'Simple view' }));
  await screen.findByTestId('universe-simple');
  const section = await screen.findByTestId('universe-collection-section');
  expect(section).toHaveTextContent('Orbit · 2 of 3 days this week', { exact: false });
  expect(section).toHaveTextContent('The Leaning Axis', { exact: false });
  expect(section).toHaveTextContent('Gold finish · Waiting for its planet', { exact: false });
  expect(section).toHaveTextContent(WAITING_NOTE, { exact: false });
  await act(() => h.scope.end());
  await v.unmount();
});

it('reads the collection again when the screen comes to the front, so a Scroll finished elsewhere shows at once', async () => {
  const h = universeHarness();
  const v = await open(h);
  await waitFor(() => expect(h.calls).toContain('/v1/play/landmarks/read'));
  expect(screen.queryByTestId('universe-landmark-card')).toBeNull();
  h.world.collection.landmarks = [earned()];
  const session = universeSessionFor(h.scope);
  await act(async () => {
    session.setForeground(false);
    session.setForeground(true);
    await Promise.resolve();
  });
  await waitFor(() => expect(screen.getByTestId('universe-landmark-card')).toBeOnTheScreen());
  await act(() => h.scope.end());
  await v.unmount();
});

it('is never drawn on a friend’s universe, even over a session that holds a collection (D-214)', async () => {
  const h = universeHarness();
  h.world.collection.landmarks = [earned()];
  h.world.collection.orbit = { days: 2, goal: 3, weekStart: '2026-11-02', closed: false };
  h.world.collection.resume = { assetId: fixtureId(502), title: 'Why the hemispheres take turns', part: 2, total: 3 };
  mockScope = h.scope;
  const session = universeSessionFor(h.scope);
  session.setForeground(true);
  await waitFor(() => expect(session.getState().collection.status).toBe('ready'));
  const state = session.getState();
  expect(state.collection.collection.landmarks).toHaveLength(1);
  const index = indexUniverse(descriptorsOf(state.read), []);
  const view = await render(
    <UniverseSurface
      session={session}
      state={state}
      index={index}
      status={undefined}
      visitor={{ ownerName: 'Friend', bar: null }}
    />,
  );
  await screen.findByTestId('universe-screen');
  for (const id of [
    'universe-landmark-card',
    'universe-landmark-chip',
    'universe-resume',
    'universe-orbit',
    'universe-collection-section',
  ])
    expect(screen.queryByTestId(id)).toBeNull();
  expect(allStrings(screen.toJSON()).join(' | ')).not.toMatch(/Leaning Axis|Orbit ·|Resume Part/);
  await act(() => h.scope.end());
  await view.unmount();
});

it('keeps the map working when every collection read fails: the collection is decoration, never a blocker', async () => {
  const h = universeHarness();
  const answer = h.world.reply.bind(h.world);
  h.world.reply = (path: string, body: Record<string, unknown>) => {
    if (COLLECTION_READS.includes(path)) throw new Error('fixture_collection_down');
    return answer(path, body);
  };
  const v = await open(h);
  await waitFor(() => expect(h.calls).toContain('/v1/play/landmarks/read'));
  expect(screen.getByRole('button', { name: 'CI system 0, a system' })).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: 'List view' })).toBeOnTheScreen();
  expect(screen.queryByTestId('universe-landmark-card')).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'CI system 0, a system' }));
  expect(screen.getByRole('header', { name: 'CI system 0' })).toBeOnTheScreen();
  await act(() => h.scope.end());
  await v.unmount();
});
