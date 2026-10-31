import type * as React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import type { AccountScope, RoomLaunchController, RoomLaunchState } from '@knowscroll/client-core';
import { LAUNCH_HOST, type LaunchView, type RoomLaunch } from '@knowscroll/contracts';
import { DisplayProvider } from '@knowscroll/ui';
import { LaunchPodium } from './launch-podium';
import { LaunchStage } from './launch-stage';
import { LaunchStartSheet } from './launch-start-sheet';
import { NowStrip } from './now-strip';

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(() => Promise.resolve(true)) }));
jest.mock('expo-router', () => ({
  useRouter: () => ({ navigate: jest.fn(), push: jest.fn(), replace: jest.fn(), canGoBack: () => false }),
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
// The countdown is drawn from the steady clock; a test fixes it so a number on screen is a number the view carried.
const mockNow = { current: 0 };
jest.mock('./use-launch', () => ({ useSteadyNow: () => mockNow.current, steadyClock: () => mockNow.current }));
jest.mock('./use-room', () => ({
  useRoomSky: () => ({ controller: {}, state: { phase: 'loading', view: undefined, working: false } }),
}));

const id = (n: number) => `0199f000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const person = (n: number, name: string) => ({
  kind: 'person' as const,
  personId: id(n),
  handle: `ci.${name.toLowerCase()}`,
  displayName: name,
});
const launchId = id(1);
const question = {
  launchId,
  round: 3,
  of: 5 as const,
  prompt: 'Sunlight reaches Earth in about…',
  options: ['8 seconds', '8 minutes', '8 hours'],
};
type Running = Exclude<LaunchView, { phase: 'finished' }>;
const lobby: Running = {
  phase: 'lobby',
  launchId,
  startsInMs: 12_000,
  players: [
    { person: person(10, 'Asha'), you: true },
    { person: person(11, 'Ravi'), you: false },
  ],
  youIn: true,
};
const open: Running = { phase: 'open', ...question, closesInMs: 6_500, youIn: true };
const reveal: Running = {
  phase: 'reveal',
  ...question,
  correct: 1,
  explain: 'Light takes about eight minutes to reach us.',
  locked: 4,
  right: 3,
  calledIt: [
    { person: person(10, 'Asha'), you: true },
    { person: person(12, 'Kenji'), you: false },
  ],
  yourScore: 2,
  nextInMs: 4_000,
  last: false,
  youIn: true,
};
const finished = (
  patch: Partial<Extract<LaunchView, { phase: 'finished' }>> = {},
): Extract<LaunchView, { phase: 'finished' }> => ({
  phase: 'finished',
  launchId,
  played: 5,
  podium: [
    { place: 1, score: 5, person: person(12, 'Kenji'), blockedByYou: false, you: false },
    { place: 2, score: 4, person: person(10, 'Asha'), blockedByYou: false, you: true },
    { place: 3, score: 4, person: person(11, 'Ravi'), blockedByYou: false, you: false },
  ],
  you: { score: 4, squares: [true, true, true, false, true], place: 2 },
  star: true,
  day: '2026-10-26',
  youIn: true,
  ...patch,
});
const state = (patch: Partial<RoomLaunchState> = {}): RoomLaunchState => ({
  phase: 'ready',
  view: undefined,
  receivedAt: 0,
  offline: false,
  working: false,
  refused: false,
  notSaved: undefined,
  recordingPaused: false,
  ...patch,
});
const controller = () =>
  ({
    answer: jest.fn(() => Promise.resolve(true)),
    join: jest.fn(() => Promise.resolve(true)),
    start: jest.fn(() => Promise.resolve(true)),
    load: jest.fn(),
  }) as unknown as RoomLaunchController & { answer: jest.Mock; join: jest.Mock; start: jest.Mock };
const wrap = (node: React.ReactNode) =>
  render(<DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>{node}</DisplayProvider>);

beforeEach(() => {
  mockNow.current = 0;
});

describe('the Launch on the stage', () => {
  it('has the host speak as a labelled AI, never as a person, in template words', async () => {
    await wrap(<LaunchStage launch={lobby} host={LAUNCH_HOST} state={state()} controller={controller()} />);
    expect(screen.getByTestId('launch-host-name')).toHaveTextContent('Pixel');
    expect(screen.getByLabelText('AI, Quizmaster')).toBeOnTheScreen();
    expect(screen.getByTestId('launch-host-line')).toHaveTextContent(
      'Pixel here. You’re in. We start when the clock runs out.',
    );
  });

  it('counts the lobby down from the time the view carried, and lets someone who is not in join', async () => {
    mockNow.current = 4_000;
    const actions = controller();
    await wrap(
      <LaunchStage launch={{ ...lobby, youIn: false }} host={LAUNCH_HOST} state={state()} controller={actions} />,
    );
    // 12 seconds left when the view arrived, 4 seconds of the steady clock later: 8.
    expect(screen.getByText('Starting in 8 s')).toBeOnTheScreen();
    expect(screen.getByLabelText('In this Launch: Asha, you, Ravi')).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('launch-join'));
    expect(actions.join).toHaveBeenCalledTimes(1);
  });

  it('shows an open question with its options and no sign of which is right', async () => {
    mockNow.current = 1_500;
    await wrap(<LaunchStage launch={open} host={LAUNCH_HOST} state={state()} controller={controller()} />);
    expect(screen.getByTestId('launch-prompt')).toHaveTextContent('Sunlight reaches Earth in about…');
    expect(screen.getByTestId('launch-round')).toHaveTextContent('3 OF 5');
    expect(screen.getByLabelText('5 seconds left')).toBeOnTheScreen();
    for (const index of question.options.keys())
      expect(screen.getByTestId(`launch-option-${String(index)}`)).toBeEnabled();
    expect(screen.getByLabelText('Option B: 8 minutes')).toBeOnTheScreen();
    expect(screen.queryByText(/Right answer/)).not.toBeOnTheScreen();
    expect(screen.queryByTestId('launch-reveal')).not.toBeOnTheScreen();
    expect(screen.queryByText(/called it/)).not.toBeOnTheScreen();
  });

  it('sends the option tapped, shows it locked in, and takes no second answer', async () => {
    const actions = controller();
    const { rerender } = await wrap(
      <LaunchStage launch={open} host={LAUNCH_HOST} state={state()} controller={actions} />,
    );
    await fireEvent.press(screen.getByTestId('launch-option-2'));
    expect(actions.answer).toHaveBeenCalledWith(2);
    await rerender(
      <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
        <LaunchStage launch={{ ...open, yourChoice: 2 }} host={LAUNCH_HOST} state={state()} controller={actions} />
      </DisplayProvider>,
    );
    expect(screen.getByLabelText('Option C: 8 hours, Locked in')).toBeOnTheScreen();
    expect(screen.getByTestId('launch-locked')).toBeOnTheScreen();
    expect(screen.getByTestId('launch-option-0')).toBeDisabled();
  });

  it('says in words which option was right and which was yours once the question has closed, and who called it', async () => {
    await wrap(
      <LaunchStage
        launch={{ ...reveal, yourChoice: 0 }}
        host={LAUNCH_HOST}
        state={state()}
        controller={controller()}
      />,
    );
    expect(screen.getByLabelText('Option B: 8 minutes, Right answer')).toBeOnTheScreen();
    expect(screen.getByLabelText('Option A: 8 seconds, Your pick')).toBeOnTheScreen();
    expect(screen.getByTestId('launch-explain')).toHaveTextContent('Light takes about eight minutes to reach us.');
    expect(screen.getByTestId('launch-called')).toHaveTextContent('3 of 4 called it');
    expect(screen.getByLabelText('Called it: Asha, you, Kenji')).toBeOnTheScreen();
    // A wrong pick is never shamed: no "wrong", no "lost", no "fail" anywhere on the stage.
    expect(screen.queryByText(/wrong|incorrect|lost|fail/i)).not.toBeOnTheScreen();
    expect(screen.getByTestId('launch-host-line')).toHaveTextContent('Plot twist. On to the next one.');
  });

  it('says when nobody answered, and does not invent a number', async () => {
    await wrap(
      <LaunchStage
        launch={{ ...reveal, locked: 0, right: 0, calledIt: [] }}
        host={LAUNCH_HOST}
        state={state()}
        controller={controller()}
      />,
    );
    expect(screen.getByTestId('launch-called')).toHaveTextContent('Nobody answered this one.');
  });

  it('says plainly that recording is paused before any tap, and offers nothing to tap', async () => {
    const actions = controller();
    await wrap(
      <LaunchStage launch={open} host={LAUNCH_HOST} state={state({ recordingPaused: true })} controller={actions} />,
    );
    expect(screen.getByTestId('launch-paused')).toHaveTextContent(/can’t be played while recording is paused/);
    for (const index of open.options.keys())
      expect(screen.getByTestId(`launch-option-${String(index)}`)).toBeDisabled();
    await fireEvent.press(screen.getByTestId('launch-option-0'));
    expect(actions.answer).not.toHaveBeenCalled();
  });

  it('offers no Join while recording is paused, in the lobby too', async () => {
    const actions = controller();
    await wrap(
      <LaunchStage
        launch={{ ...lobby, youIn: false }}
        host={LAUNCH_HOST}
        state={state({ recordingPaused: true })}
        controller={actions}
      />,
    );
    expect(screen.getByTestId('launch-paused')).toBeOnTheScreen();
    expect(screen.getByTestId('launch-join')).toBeDisabled();
    await fireEvent.press(screen.getByTestId('launch-join'));
    expect(actions.join).not.toHaveBeenCalled();
  });

  it('says that an answer was refused as too late, and nothing about recording', async () => {
    await wrap(
      <LaunchStage launch={open} host={LAUNCH_HOST} state={state({ refused: true })} controller={controller()} />,
    );
    expect(screen.getByText('Too late for that one.')).toBeOnTheScreen();
    expect(screen.queryByTestId('launch-paused')).not.toBeOnTheScreen();
  });

  it('says that the connection is gone, and that the next answer will go when it is back', async () => {
    await wrap(
      <LaunchStage launch={open} host={LAUNCH_HOST} state={state({ offline: true })} controller={controller()} />,
    );
    expect(screen.getByText('Reconnecting…')).toBeOnTheScreen();
  });

  it('says the device’s recording setting was out of date when the server refused to keep an answer', async () => {
    await wrap(
      <LaunchStage
        launch={open}
        host={LAUNCH_HOST}
        state={state({ notSaved: 'recording_generation_stale' })}
        controller={controller()}
      />,
    );
    expect(screen.getByTestId('launch-stale')).toBeOnTheScreen();
  });

  it('is an onlooker until someone answers: a person who has not joined is told they are watching', async () => {
    await wrap(
      <LaunchStage launch={{ ...open, youIn: false }} host={LAUNCH_HOST} state={state()} controller={controller()} />,
    );
    expect(screen.getByTestId('launch-watching')).toBeOnTheScreen();
  });
});

describe('the podium', () => {
  const props = (launch = finished()) => ({
    scope: { api: { rooms: { send: jest.fn(() => Promise.resolve({})) } } } as unknown as AccountScope,
    launch,
    roomId: id(2),
    roomName: 'Space room',
    generalId: id(3),
    sky: { lit: 5, of: 7 as const, state: 'forming' as const, finished: 0 },
    visible: true,
    onClose: jest.fn(),
  });

  it('stands the first three on their steps with their scores, for this Launch only, and says nobody below third is listed', async () => {
    await wrap(<LaunchPodium {...props()} />);
    expect(screen.getByText('Tonight’s podium')).toBeOnTheScreen();
    expect(screen.getByText('Top 3 of this quiz only. Gone after tonight; tomorrow starts empty.')).toBeOnTheScreen();
    expect(screen.getByLabelText('First, Kenji, 5 of 5')).toBeOnTheScreen();
    expect(screen.getByLabelText('Second, Asha, you, 4 of 5')).toBeOnTheScreen();
    expect(screen.getByLabelText('Third, Ravi, 4 of 5')).toBeOnTheScreen();
    expect(screen.getByText(/2 others played too; nobody below third is listed\./)).toBeOnTheScreen();
    // There is no weekly, monthly or all-time anything on it.
    expect(screen.queryByText(/week|month|all-time|leaderboard|total score|level|streak/i)).not.toBeOnTheScreen();
  });

  it('draws a person the reader blocked as a place with no name', async () => {
    const launch = finished({
      podium: [
        { place: 1, score: 5, blockedByYou: true, you: false },
        { place: 2, score: 4, person: person(10, 'Asha'), blockedByYou: false, you: true },
      ],
    });
    await wrap(<LaunchPodium {...props(launch)} />);
    expect(screen.getByLabelText('First, Someone you blocked, 5 of 5')).toBeOnTheScreen();
    expect(screen.queryByText('Kenji')).not.toBeOnTheScreen();
  });

  it('says the room earned a star, with how the sky stands, only when it did', async () => {
    const { unmount } = await wrap(<LaunchPodium {...props()} />);
    expect(screen.getByTestId('podium-star')).toHaveTextContent(/1 star for the room/);
    expect(screen.getByTestId('podium-star')).toHaveTextContent(/2 more stars light the station/);
    await unmount();
    await wrap(<LaunchPodium {...props(finished({ star: false }))} />);
    expect(screen.queryByTestId('podium-star')).not.toBeOnTheScreen();
  });

  it('draws the share card as squares with no answer in it, and copies and shares it as text', async () => {
    const shared = props();
    await wrap(<LaunchPodium {...shared} />);
    expect(screen.getByText('Space room · Launch 26 Oct · 4/5')).toBeOnTheScreen();
    expect(screen.getByText('Copies as text: ■■■□■. No answers in it, so it can’t spoil anything.')).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('launch-copy'));
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith('Space room · Launch 26 Oct · 4/5\n■■■□■');
    await fireEvent.press(screen.getByTestId('launch-share'));
    await waitFor(() => expect(screen.getByText('Shared in General')).toBeOnTheScreen());
    const send = (shared.scope.api.rooms as unknown as { send: jest.Mock }).send;
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: id(2),
        discussionId: id(3),
        body: { kind: 'text', text: 'Space room · Launch 26 Oct · 4/5\n■■■□■' },
      }),
    );
    await fireEvent.press(screen.getByTestId('launch-close'));
    expect(shared.onClose).toHaveBeenCalled();
  });

  it('says when the share did not reach the room, and offers nothing to share to someone who did not play', async () => {
    const failing = props();
    (failing.scope.api.rooms as unknown as { send: jest.Mock }).send.mockRejectedValue(new Error('network'));
    const { unmount } = await wrap(<LaunchPodium {...failing} />);
    await fireEvent.press(screen.getByTestId('launch-share'));
    await waitFor(() => expect(screen.getByTestId('podium-share-failed')).toBeOnTheScreen());
    await unmount();
    const watching: Partial<Extract<LaunchView, { phase: 'finished' }>> = { youIn: false };
    await wrap(<LaunchPodium {...props({ ...finished(watching), you: undefined })} />);
    expect(screen.getByTestId('podium-watched')).toBeOnTheScreen();
    expect(screen.queryByTestId('launch-share-card')).not.toBeOnTheScreen();
    expect(screen.queryByTestId('launch-share')).not.toBeOnTheScreen();
    expect(screen.getByTestId('launch-close')).toBeOnTheScreen();
  });

  it('says so without shaming when nobody got a question right', async () => {
    await wrap(<LaunchPodium {...props(finished({ podium: [], star: false }))} />);
    expect(screen.getByTestId('podium-empty')).toHaveTextContent(/Nobody got a question right this time./);
  });
});

describe('where a Launch starts', () => {
  const ready = (start: NonNullable<Extract<RoomLaunch, { status: 'ready' }>['start']>) =>
    ({ status: 'ready', host: LAUNCH_HOST, start }) as unknown as Extract<RoomLaunch, { status: 'ready' }>;

  it('offers Start only when the server says one can start, and says why not otherwise', async () => {
    const actions = controller();
    const { rerender } = await wrap(
      <LaunchStartSheet
        visible
        host={LAUNCH_HOST}
        view={ready({ allowed: false, reason: 'few_here' })}
        state={state()}
        onStart={() => void actions.start()}
        onClose={jest.fn()}
      />,
    );
    expect(screen.getByTestId('launch-start-blocked')).toHaveTextContent(
      /A Launch needs two people with the room open./,
    );
    expect(screen.getByTestId('launch-start')).toBeDisabled();
    await rerender(
      <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
        <LaunchStartSheet
          visible
          host={LAUNCH_HOST}
          view={ready({ allowed: true })}
          state={state()}
          onStart={() => void actions.start()}
          onClose={jest.fn()}
        />
      </DisplayProvider>,
    );
    await fireEvent.press(screen.getByTestId('launch-start'));
    expect(actions.start).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/no one is picked for you/)).toBeOnTheScreen();
    expect(screen.getByLabelText('AI, Quizmaster')).toBeOnTheScreen();
  });

  it('says that recording is paused before anyone presses Start, and does not offer to start', async () => {
    await wrap(
      <LaunchStartSheet
        visible
        host={LAUNCH_HOST}
        view={ready({ allowed: true })}
        state={state({ recordingPaused: true })}
        onStart={jest.fn()}
        onClose={jest.fn()}
      />,
    );
    expect(screen.getByTestId('launch-start-paused')).toBeOnTheScreen();
    expect(screen.getByTestId('launch-start')).toBeDisabled();
  });
});

describe('the Now strip chip', () => {
  const strip = (launch: { state: 'ready' | 'lobby' | 'live' | 'finished' } | undefined, onLaunch = jest.fn()) =>
    wrap(
      <NowStrip
        scope={{ queryKey: () => [] } as unknown as AccountScope}
        roomId={id(2)}
        today={undefined}
        sky={{ lit: 1, of: 7, state: 'forming', finished: 0 }}
        launch={launch}
        onLaunch={onLaunch}
      />,
    );

  it('says nothing when there is nothing to say, and names each state in words', async () => {
    const { unmount } = await strip(undefined);
    expect(screen.queryByTestId('now-launch')).not.toBeOnTheScreen();
    await unmount();
    for (const [state, words] of [
      ['ready', 'Start a quiz'],
      ['lobby', 'Starting now · join'],
      ['live', 'Live now'],
      ['finished', 'Podium'],
    ] as const) {
      const view = await strip({ state });
      expect(screen.getByTestId('now-launch')).toHaveTextContent(new RegExp(words));
      expect(screen.getByLabelText(`Launch, ${words}`)).toBeOnTheScreen();
      await view.unmount();
    }
  });

  it('tells the room the chip was pressed', async () => {
    const onLaunch = jest.fn();
    await strip({ state: 'ready' }, onLaunch);
    await fireEvent.press(screen.getByTestId('now-launch'));
    expect(onLaunch).toHaveBeenCalledTimes(1);
  });
});
