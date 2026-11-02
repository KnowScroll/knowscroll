import * as React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import {
  createRoomWatch,
  type AccountScope,
  type RoomWatchController,
  type RoomWatchState,
} from '@knowscroll/client-core';
import type { RoomWatch, WatchSessionView } from '@knowscroll/contracts';
import { DisplayProvider } from '@knowscroll/ui';
import { RoomPanels, RoomTabBar, type RoomTab } from './room-tabs';
import { WatchSheet } from './watch-sheet';
import { WatchStage } from './watch-stage';

// The real stage and sheet over labelled fixtures. Only the player view, the Reel's exposure and route focus are stand-ins: no
// playback or backend is claimed. What is asserted is what the screen asks of them, and when.
let mockFocused = true;
jest.mock('expo-router', () => ({ useIsFocused: () => mockFocused }));
const mockNow = { current: 0 };
jest.mock('./use-launch', () => ({ useSteadyNow: () => mockNow.current, steadyClock: () => mockNow.current }));
const mockStart = jest.fn();
const mockExposure: { current: object } = { current: { status: 'idle' } };
const mockUseExposure = jest.fn();
jest.mock('../threads/reel-encounter', () => ({
  useReelExposure: (scope: unknown, assetId: string) => {
    mockUseExposure(scope, assetId);
    return { state: mockExposure.current, start: mockStart };
  },
}));
interface PlayerProps {
  initialPositionMs: number;
  initialPlaying: boolean;
  controls: { tapToToggle: boolean };
  active: boolean;
}
const mockPlayer = jest.fn<void, [PlayerProps]>();
const lastPlayer = (): PlayerProps => {
  const call = mockPlayer.mock.calls.at(-1);
  if (call === undefined) throw new Error('the player was never drawn');
  return call[0];
};
const mockToggle = jest.fn();
const mockSeekBy = jest.fn();
const mockPlayback: { current: { positionMs: number; playing: boolean; muted: boolean } } = {
  current: { positionMs: 0, playing: true, muted: false },
};
jest.mock('../reel/activated-reel-view', () => ({
  ActivatedReelView: (props: {
    controls?: { controlsRef: { current: unknown } };
    children?: (playback: unknown) => unknown;
  }) => {
    mockPlayer(props as unknown as PlayerProps);
    if (props.controls) props.controls.controlsRef.current = { toggle: mockToggle, seekBy: mockSeekBy };
    return props.children?.({
      ...mockPlayback.current,
      durationMs: 70_000,
      status: 'ready',
      toggleMuted: jest.fn(),
    });
  },
}));

const id = (n: number) => `0199d000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const reel = { assetId: id(3), assetRevision: 1, title: 'How big is the universe?', durationMs: 70_000 };
const lena = { kind: 'person' as const, personId: id(9), handle: 'ci.lena', displayName: 'Lena' };
const base = { sessionId: id(2), reel, youIn: false, canStop: false, sharedBy: lena };
const playing = (over: object = {}): WatchSessionView => ({ phase: 'playing', ...base, elapsedMs: 41_000, ...over });
const starting = (over: object = {}): WatchSessionView => ({ phase: 'starting', ...base, startsInMs: 4_000, ...over });

const stateOf = (patch: Partial<RoomWatchState> = {}): RoomWatchState => ({
  phase: 'ready',
  view: undefined,
  receivedAt: 0,
  reels: undefined,
  reelsFailed: false,
  offline: false,
  working: false,
  refused: false,
  joinedHere: [],
  recordingPaused: false,
  notSaved: undefined,
  ...patch,
});
/** The state of a device whose own person joined from it: the server says they are in, and so does this device. */
const joinedState = (patch: Partial<RoomWatchState> = {}) => stateOf({ joinedHere: [base.sessionId], ...patch });
const controllerOf = (over: object = {}) =>
  ({
    load: jest.fn(),
    loadReels: jest.fn(),
    start: jest.fn(() => Promise.resolve(true)),
    join: jest.fn(() => Promise.resolve(true)),
    leave: jest.fn(() => Promise.resolve(true)),
    stop: jest.fn(() => Promise.resolve(true)),
    ...over,
  }) as unknown as RoomWatchController & Record<'load' | 'loadReels' | 'start' | 'join' | 'leave' | 'stop', jest.Mock>;
const scope = { active: true } as unknown as AccountScope;
const wrap = (node: React.ReactNode) =>
  render(<DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>{node}</DisplayProvider>);
const ready = (extra: object = {}): Extract<RoomWatch, { status: 'ready' }> =>
  ({
    status: 'ready',
    readId: id(7),
    version: 'rooms.v1',
    scope: { accountId: id(1), privacyEpoch: 1 },
    ...extra,
  }) as never;

beforeEach(() => {
  mockFocused = true;
  mockNow.current = 0;
  mockPlayback.current = { positionMs: 0, playing: true, muted: false };
  mockExposure.current = { status: 'idle' };
  for (const fn of [mockStart, mockUseExposure, mockPlayer, mockToggle, mockSeekBy]) fn.mockClear();
});

describe('the stage for someone who has not joined (R3 A2)', () => {
  it('says what is playing and who shared it, and opens nothing: the session alone is nobody’s encounter', async () => {
    await wrap(<WatchStage scope={scope} session={playing()} state={stateOf()} controller={controllerOf()} />);
    expect(screen.getByText('REEL · SHARED BY LENA')).toBeOnTheScreen();
    expect(screen.getByTestId('watch-title')).toHaveTextContent('How big is the universe?');
    expect(screen.getByTestId('watch-line')).toHaveTextContent('0:41 / 1:10 · synced for everyone');
    expect(screen.getByLabelText('A Reel watched together')).toBeOnTheScreen();
    // No exposure is asked for and no player is drawn until the person joins.
    expect(mockUseExposure).not.toHaveBeenCalled();
    expect(mockStart).not.toHaveBeenCalled();
    expect(mockPlayer).not.toHaveBeenCalled();
  });

  it('counts the seconds of the shared clock with the steady clock since the read arrived', async () => {
    mockNow.current = 2_000;
    await wrap(
      <WatchStage scope={scope} session={playing()} state={stateOf({ receivedAt: 0 })} controller={controllerOf()} />,
    );
    expect(screen.getByTestId('watch-line')).toHaveTextContent('0:43 / 1:10 · synced for everyone');
  });

  it('says how long before the first frame while the session is starting', async () => {
    await wrap(<WatchStage scope={scope} session={starting()} state={stateOf()} controller={controllerOf()} />);
    expect(screen.getByTestId('watch-line')).toHaveTextContent('Starting in 4 s');
  });

  it('says "N watching" only when the view carries the number, which it does only from three', async () => {
    const first = await wrap(
      <WatchStage scope={scope} session={playing()} state={stateOf()} controller={controllerOf()} />,
    );
    expect(screen.queryByTestId('watch-count')).not.toBeOnTheScreen();
    expect(screen.queryByText(/watching/i)).not.toBeOnTheScreen();
    await first.unmount();
    await wrap(
      <WatchStage scope={scope} session={playing({ watching: 4 })} state={stateOf()} controller={controllerOf()} />,
    );
    expect(screen.getByTestId('watch-count')).toHaveTextContent('4 watching');
  });

  it('joins only on the person’s own tap, and never names who else has', async () => {
    const controller = controllerOf();
    await wrap(<WatchStage scope={scope} session={playing()} state={stateOf()} controller={controller} />);
    expect(controller.join).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('watch-join'));
    expect(controller.join).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/is watching|are watching|joined/i)).not.toBeOnTheScreen();
  });

  it('offers no Join while recording is paused, and says why before any tap', async () => {
    const controller = controllerOf();
    await wrap(
      <WatchStage
        scope={scope}
        session={playing()}
        state={stateOf({ recordingPaused: true })}
        controller={controller}
      />,
    );
    expect(screen.getByTestId('watch-paused')).toHaveTextContent(/^Recording is paused./);
    await fireEvent.press(screen.getByTestId('watch-join'));
    expect(controller.join).not.toHaveBeenCalled();
  });

  it('lets the member who shared it, or a moderator, end it for everyone, and nobody else', async () => {
    const controller = controllerOf();
    const first = await wrap(
      <WatchStage scope={scope} session={playing()} state={stateOf()} controller={controller} />,
    );
    expect(screen.queryByTestId('watch-stop')).not.toBeOnTheScreen();
    await first.unmount();
    await wrap(
      <WatchStage scope={scope} session={playing({ canStop: true })} state={stateOf()} controller={controller} />,
    );
    await fireEvent.press(screen.getByTestId('watch-stop'));
    expect(controller.stop).toHaveBeenCalledTimes(1);
  });

  it('says it is reconnecting while the connection is down, and that the clock keeps time', async () => {
    await wrap(
      <WatchStage scope={scope} session={playing()} state={stateOf({ offline: true })} controller={controllerOf()} />,
    );
    expect(screen.getByTestId('watch-offline')).toHaveTextContent(/keeps time without the connection/);
  });
});

describe('the stage for someone who joined', () => {
  const joined = (over: object = {}) => playing({ youIn: true, ...over });
  const opened = () => {
    mockExposure.current = {
      status: 'ready',
      exposure: {
        exposureId: id(40),
        document: { assetId: reel.assetId, revision: 1, title: reel.title, durationMs: 70_000 },
        recorder: { end: jest.fn() },
      },
    };
  };

  it('asks for the Reel’s own encounter once, and shows it is opening until it is', async () => {
    await wrap(<WatchStage scope={scope} session={joined()} state={joinedState()} controller={controllerOf()} />);
    expect(mockUseExposure).toHaveBeenCalledWith(scope, reel.assetId);
    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('watch-opening')).toBeOnTheScreen();
    expect(mockPlayer).not.toHaveBeenCalled();
  });

  it('plays the Reel from where the shared clock is, on and unattended, with the player’s own controls turned off', async () => {
    opened();
    mockNow.current = 1_500;
    await wrap(<WatchStage scope={scope} session={joined()} state={joinedState()} controller={controllerOf()} />);
    const props = lastPlayer();
    expect(props.initialPositionMs).toBe(42_500);
    expect(props.initialPlaying).toBe(true);
    expect(props.controls.tapToToggle).toBe(false);
    expect(props.active).toBe(true);
    expect(screen.getByTestId('watch-line')).toHaveTextContent('0:42 / 1:10 · synced for everyone');
    expect(screen.getByRole('progressbar')).toBeOnTheScreen();
  });

  it('waits for the first frame in words, then plays: before it, the player is not drawn', async () => {
    opened();
    await wrap(
      <WatchStage
        scope={scope}
        session={starting({ youIn: true })}
        state={joinedState()}
        controller={controllerOf()}
      />,
    );
    expect(screen.getByTestId('watch-starting')).toBeOnTheScreen();
    expect(screen.getByTestId('watch-title')).toHaveTextContent('Starting in 4 s');
    expect(mockPlayer).not.toHaveBeenCalled();
  });

  it('moves the player to the clock when it has drifted, leaves one that is keeping time, and never chases a seek', async () => {
    opened();
    mockPlayback.current = { positionMs: 41_000, playing: true, muted: false };
    const view = await wrap(
      <WatchStage scope={scope} session={joined()} state={joinedState()} controller={controllerOf()} />,
    );
    expect(mockSeekBy).not.toHaveBeenCalled();
    // The player falls 4 s behind the clock: it is moved up to it.
    mockPlayback.current = { positionMs: 38_000, playing: true, muted: false };
    mockNow.current = 4_000;
    await act(() =>
      view.rerender(
        <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
          <WatchStage scope={scope} session={joined()} state={joinedState()} controller={controllerOf()} />
        </DisplayProvider>,
      ),
    );
    expect(mockSeekBy).toHaveBeenCalledTimes(1);
    expect(mockSeekBy).toHaveBeenCalledWith(expect.closeTo(7, 1));
    // Still behind a moment later, but a seek was just made: it is left to land.
    mockNow.current = 4_500;
    mockPlayback.current = { positionMs: 38_400, playing: true, muted: false };
    await act(() =>
      view.rerender(
        <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
          <WatchStage scope={scope} session={joined()} state={joinedState()} controller={controllerOf()} />
        </DisplayProvider>,
      ),
    );
    expect(mockSeekBy).toHaveBeenCalledTimes(1);
  });

  it('lets a person pause for themselves without moving anyone else, and does not seek a paused player', async () => {
    opened();
    mockPlayback.current = { positionMs: 20_000, playing: false, muted: false };
    await wrap(<WatchStage scope={scope} session={joined()} state={joinedState()} controller={controllerOf()} />);
    expect(screen.getByRole('button', { name: 'Play' })).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('watch-toggle'));
    expect(mockToggle).toHaveBeenCalledTimes(1);
    expect(mockSeekBy).not.toHaveBeenCalled();
  });

  it('leaves the stage from the stage, and the Reel is not shown to anyone as having left', async () => {
    opened();
    const controller = controllerOf();
    await wrap(<WatchStage scope={scope} session={joined()} state={joinedState()} controller={controller} />);
    await fireEvent.press(screen.getByTestId('watch-leave'));
    expect(controller.leave).toHaveBeenCalledTimes(1);
  });

  it('pauses the player when another screen takes focus', async () => {
    opened();
    mockFocused = false;
    await wrap(<WatchStage scope={scope} session={joined()} state={joinedState()} controller={controllerOf()} />);
    expect(lastPlayer().active).toBe(false);
  });

  it('plays only while General is the open tab of the room, and picks up again when General is shown', async () => {
    opened();
    function Tabbed() {
      const [tab, setTab] = React.useState<RoomTab>('general');
      return (
        <>
          <RoomTabBar tab={tab} onSelect={setTab} />
          <RoomPanels
            tab={tab}
            general={<WatchStage scope={scope} session={joined()} state={joinedState()} controller={controllerOf()} />}
            feed={null}
            topics={null}
          />
        </>
      );
    }
    await wrap(<Tabbed />);
    expect(lastPlayer().active).toBe(true);
    // Behind the Feed the stage is still mounted (it keeps its place) but the player is told it is not on screen, so it neither
    // plays with sound nor samples.
    await fireEvent.press(screen.getByTestId('room-tab-feed'));
    expect(lastPlayer().active).toBe(false);
    await fireEvent.press(screen.getByTestId('room-tab-topics'));
    expect(lastPlayer().active).toBe(false);
    await fireEvent.press(screen.getByTestId('room-tab-general'));
    expect(lastPlayer().active).toBe(true);
    // The route's own focus still counts: General is open, but another screen is over the room.
    mockFocused = false;
    await fireEvent.press(screen.getByTestId('room-tab-feed'));
    await fireEvent.press(screen.getByTestId('room-tab-general'));
    expect(lastPlayer().active).toBe(false);
  });

  it('says so when the Reel cannot be opened, and still lets the person leave', async () => {
    mockExposure.current = { status: 'unavailable' };
    const controller = controllerOf();
    await wrap(<WatchStage scope={scope} session={joined()} state={joinedState()} controller={controller} />);
    expect(screen.getByTestId('watch-title')).toHaveTextContent('This Reel isn’t available');
    await fireEvent.press(screen.getByTestId('watch-leave'));
    expect(controller.leave).toHaveBeenCalled();
  });

  it('says the Reel is over when the clock says so, before the next read arrives', async () => {
    opened();
    mockNow.current = 29_000;
    await wrap(<WatchStage scope={scope} session={joined()} state={joinedState()} controller={controllerOf()} />);
    expect(screen.getByTestId('watch-ended')).toBeOnTheScreen();
    expect(screen.getByTestId('watch-title')).toHaveTextContent('That’s the Reel.');
    expect(mockPlayer).not.toHaveBeenCalled();
  });
});

/**
 * The real controller over a labelled server, behind the stage. What the server says (the person is in) is not what this device did:
 * only a Join accepted on this device opens the Reel here (D-258). A second device of the same person, and a room reopened while
 * the person's place still stands, show Join and open nothing.
 */
describe('a device opens the Reel only after its own Join (D-258)', () => {
  /** A server with one session, whose viewer row is the person's: `youIn` is that row, whatever device asks. */
  function server(youIn: boolean) {
    const row = { youIn };
    const sent: string[] = [];
    const rooms = {
      watch: () => Promise.resolve(ready({ session: playing({ youIn: row.youIn }) })),
      joinWatch: () => {
        sent.push('join');
        row.youIn = true;
        return Promise.resolve({ outcome: 'accepted', sessionId: base.sessionId });
      },
      leaveWatch: () => {
        sent.push('leave');
        row.youIn = false;
        return Promise.resolve({ outcome: 'accepted', sessionId: base.sessionId });
      },
    };
    const recording = {
      getState: () => ({ policy: { on: true, generation: 1 } }),
      generation: () => Promise.resolve(1),
      refresh: () => Promise.resolve(true),
      subscribe: () => () => undefined,
    };
    const live = { active: true, api: { rooms }, recording } as unknown as AccountScope;
    return { row, sent, live };
  }
  let counter = 500;
  const open = (live: AccountScope) =>
    createRoomWatch({ scope: live, roomId: id(1), newId: () => id(counter++), clock: () => mockNow.current });

  /** The screen of one device: it reads the controller and draws the stage when there is a session. */
  function Device({ live, controller }: { readonly live: AccountScope; readonly controller: RoomWatchController }) {
    const state = React.useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
    const session = state.view?.session;
    return session === undefined ? null : (
      <WatchStage scope={live} session={session} state={state} controller={controller} />
    );
  }
  const openedExposure = () => {
    mockExposure.current = {
      status: 'ready',
      exposure: {
        exposureId: id(40),
        document: { assetId: reel.assetId, revision: 1, title: reel.title, durationMs: 70_000 },
        recorder: { end: jest.fn() },
      },
    };
  };

  it('opens nothing on a device that never joined, though the server says the person is in', async () => {
    openedExposure();
    const { live } = server(true);
    const controller = open(live);
    await act(() => controller.load());
    await wrap(<Device live={live} controller={controller} />);
    expect(controller.getState().view?.session?.youIn).toBe(true);
    expect(controller.getState().joinedHere).toEqual([]);
    expect(screen.getByTestId('watch-join')).toBeOnTheScreen();
    expect(mockUseExposure).not.toHaveBeenCalled();
    expect(mockStart).not.toHaveBeenCalled();
    expect(mockPlayer).not.toHaveBeenCalled();
  });

  it('opens exactly one encounter for a Join on this device, and no second one however often the stage is read', async () => {
    openedExposure();
    const { live, sent, row } = server(false);
    const controller = open(live);
    await act(() => controller.load());
    await wrap(<Device live={live} controller={controller} />);
    expect(mockStart).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('watch-join'));
    await act(() => Promise.resolve());
    expect(sent).toEqual(['join']);
    expect(row.youIn).toBe(true);
    expect(controller.getState().joinedHere).toEqual([base.sessionId]);
    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(mockPlayer).toHaveBeenCalled();
    for (let read = 0; read < 3; read++) await act(() => controller.load());
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  it('shows Join, not a playing Reel, when the room is reopened while the person’s place still stands', async () => {
    openedExposure();
    const { live, row } = server(false);
    const first = open(live);
    await act(() => first.load());
    const view = await wrap(<Device live={live} controller={first} />);
    await fireEvent.press(screen.getByTestId('watch-join'));
    await act(() => Promise.resolve());
    expect(mockStart).toHaveBeenCalledTimes(1);
    // The room is closed and opened again: a new screen, a new controller. The server still holds the person's place.
    await view.unmount();
    mockStart.mockClear();
    mockPlayer.mockClear();
    mockUseExposure.mockClear();
    expect(row.youIn).toBe(true);
    const second = open(live);
    await act(() => second.load());
    await wrap(<Device live={live} controller={second} />);
    expect(screen.getByTestId('watch-join')).toBeOnTheScreen();
    expect(screen.queryByTestId('watch-title')?.props.children).toBe(reel.title);
    expect(mockUseExposure).not.toHaveBeenCalled();
    expect(mockStart).not.toHaveBeenCalled();
    expect(mockPlayer).not.toHaveBeenCalled();
  });

  it('shows Join again after leaving, and a place that was taken away does not come back on its own', async () => {
    openedExposure();
    const { live, row } = server(false);
    const controller = open(live);
    await act(() => controller.load());
    await wrap(<Device live={live} controller={controller} />);
    await fireEvent.press(screen.getByTestId('watch-join'));
    await act(() => Promise.resolve());
    await fireEvent.press(screen.getByTestId('watch-leave'));
    await act(() => Promise.resolve());
    expect(controller.getState().joinedHere).toEqual([]);
    expect(screen.getByTestId('watch-join')).toBeOnTheScreen();
    // The person joins again from another device: the server says they are in, this device still opens nothing.
    mockStart.mockClear();
    row.youIn = true;
    await act(() => controller.load());
    expect(screen.getByTestId('watch-join')).toBeOnTheScreen();
    expect(mockStart).not.toHaveBeenCalled();
  });
});

describe('the stage when nothing is on it (R3 A2 "Nothing live")', () => {
  const view = (over: object = {}) =>
    ready({ start: { allowed: true }, last: { kind: 'launch', at: '2026-10-31T21:30:00.000Z' }, ...over });
  const sheet = (state: RoomWatchState, controller = controllerOf(), extra: object = {}) => (
    <WatchSheet
      visible
      state={state}
      controller={controller}
      canStartQuiz={false}
      onStartQuiz={jest.fn()}
      onClose={jest.fn()}
      {...extra}
    />
  );

  it('says there is nothing on stage and what was last on it, and offers a Reel', async () => {
    await wrap(sheet(stateOf({ view: view() })));
    expect(screen.getByText('Nothing on stage right now')).toBeOnTheScreen();
    expect(screen.getByTestId('watch-last')).toHaveTextContent(/^Last on stage: the Launch, /);
    expect(screen.getByRole('button', { name: 'Watch a Reel together' })).toBeOnTheScreen();
    expect(screen.queryByTestId('watch-quiz')).not.toBeOnTheScreen();
  });

  it('says so, without a time, for a room whose stage never had anything', async () => {
    await wrap(sheet(stateOf({ view: view({ last: undefined }) })));
    expect(screen.getByTestId('watch-last')).toHaveTextContent('Nothing has been on this room’s stage yet.');
  });

  it('offers a quiz beside it only when one can be started, and hands over to the Launch', async () => {
    const onStartQuiz = jest.fn();
    await wrap(sheet(stateOf({ view: view() }), controllerOf(), { canStartQuiz: true, onStartQuiz }));
    await fireEvent.press(screen.getByTestId('watch-quiz'));
    expect(onStartQuiz).toHaveBeenCalledTimes(1);
  });

  it('lists the Reels the room’s topic rests on, with their length, and starts the one that is tapped', async () => {
    const controller = controllerOf();
    const other = { ...reel, assetId: id(4), title: 'What is a light-year?', durationMs: 45_000 };
    await wrap(sheet(stateOf({ view: view(), reels: [reel, other] }), controller));
    await fireEvent.press(screen.getByTestId('watch-choose'));
    expect(controller.loadReels).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Reel · 1:10')).toBeOnTheScreen();
    expect(screen.getByText('Reel · 0:45')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Watch What is a light-year? together' }));
    expect(controller.start).toHaveBeenCalledWith(other.assetId);
  });

  it('says why a Reel cannot be started, and offers none to start', async () => {
    await wrap(sheet(stateOf({ view: view({ start: { allowed: false, reason: 'few_here' } }) })));
    expect(screen.getByTestId('watch-blocked')).toHaveTextContent(/two people with the room open/);
    await fireEvent.press(screen.getByTestId('watch-choose'));
    expect(screen.queryByTestId('watch-reels')).not.toBeOnTheScreen();
  });

  it('says recording is paused before any tap, and starts nothing', async () => {
    const controller = controllerOf();
    await wrap(sheet(stateOf({ view: view(), recordingPaused: true, reels: [reel] }), controller));
    expect(screen.getByTestId('watch-sheet-paused')).toHaveTextContent(/^Recording is paused./);
    await fireEvent.press(screen.getByTestId('watch-choose'));
    expect(controller.loadReels).not.toHaveBeenCalled();
  });

  it('says when the room has no Reel, and when the Reels could not be loaded, and retries', async () => {
    const controller = controllerOf();
    const first = await wrap(sheet(stateOf({ view: view(), reels: [] }), controller));
    await fireEvent.press(screen.getByTestId('watch-choose'));
    expect(screen.getByTestId('watch-no-reels')).toBeOnTheScreen();
    await first.unmount();
    await wrap(sheet(stateOf({ view: view(), reelsFailed: true }), controller));
    await fireEvent.press(screen.getByTestId('watch-choose'));
    await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
    expect(controller.loadReels).toHaveBeenCalledTimes(3);
  });
});
