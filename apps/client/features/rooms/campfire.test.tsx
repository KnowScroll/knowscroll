import type * as React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { AccountScope, RoomController, RoomLaunchState, RoomState } from '@knowscroll/client-core';
import { LAUNCH_HOST, type LaunchView, type RoomLaunch, type RoomView } from '@knowscroll/contracts';
import { DisplayProvider } from '@knowscroll/ui';
import { AiHere } from './ai-here';
import { AiNoticeCard } from './ai-notice';
import { CampfireHeader, GeneralStage } from './campfire';
import { HereNow, HereStrip } from './here-strip';
import { RoomMenu } from './room-menu';

const mockPush = jest.fn();
jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof React>('react');
  return {
    useRouter: () => ({ navigate: jest.fn(), push: mockPush, replace: jest.fn(), canGoBack: () => false }),
    useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]),
  };
});
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
// The discussion itself is read elsewhere; General here is only the place the stage puts it.
jest.mock('./discussion-screen', () => ({
  OpenDiscussion: ({
    discussionId,
    listHeader,
    listFooter,
  }: {
    discussionId: string;
    listHeader?: React.ReactNode;
    listFooter?: React.ReactNode;
  }) => {
    const { Text } = jest.requireActual<{ Text: React.ComponentType<{ testID: string; children: string }> }>(
      'react-native',
    );
    return (
      <>
        <Text testID="general-discussion">{discussionId}</Text>
        {listHeader}
        {listFooter}
      </>
    );
  },
}));
// The Launch is read elsewhere (launch.test.tsx); General here only needs it to say there is none.
const mockLaunch: { current: { controller: object; state: RoomLaunchState } } = {
  current: {
    controller: {},
    state: {
      phase: 'ready',
      view: undefined,
      receivedAt: 0,
      offline: false,
      working: false,
      refused: false,
      notSaved: undefined,
      recordingPaused: false,
    },
  },
};
jest.mock('./use-launch', () => ({ useRoomLaunch: () => mockLaunch.current, useSteadyNow: () => 0 }));
// The stage itself is drawn in watch.test.tsx; General here only needs to know whether a session is on, and to open the sheet.
const mockWatch: { current: { controller: object; state: object } } = {
  current: {
    controller: {
      load: jest.fn(),
      loadReels: jest.fn(),
      start: jest.fn(),
      join: jest.fn(),
      leave: jest.fn(),
      stop: jest.fn(),
    },
    state: {
      phase: 'ready',
      view: undefined,
      receivedAt: 0,
      reels: undefined,
      reelsFailed: false,
      offline: false,
      working: false,
      refused: false,
      recordingPaused: false,
      notSaved: undefined,
    },
  },
};
jest.mock('./use-watch', () => ({ useRoomWatch: () => mockWatch.current }));
jest.mock('./watch-stage', () => {
  const { Text } = jest.requireActual<{ Text: React.ComponentType<{ testID: string; children: string }> }>(
    'react-native',
  );
  return { WatchStage: () => <Text testID="watch-stage">on stage</Text> };
});
// The replay is read when its sheet opens (quiet-room.test.tsx plays it); General here only needs to open and close the sheet.
const mockReplay: { current: { controller: object; state: object } } = {
  current: {
    controller: { begin: jest.fn(), leave: jest.fn(), load: jest.fn() },
    state: {
      phase: 'ready',
      host: { name: 'Pixel', label: 'AI · Quizmaster' },
      replay: {
        launchId: '0199d000-0000-7000-8000-000000000044',
        day: '2026-10-26',
        played: 5,
        questions: [],
        answerSeconds: 8,
      },
      step: 'idle',
      index: 0,
      shownAt: 0,
      picked: undefined,
      answer: undefined,
      squares: [],
      working: false,
      offline: false,
    },
  },
};
jest.mock('./use-replay', () => ({ useRoomReplay: () => mockReplay.current }));
jest.mock('./use-room', () => ({
  ...jest.requireActual<object>('./use-room'),
  useRoomActivities: () => ({ controller: {}, state: { activities: [], canCreate: false } }),
  useRoomSky: () => ({
    controller: {},
    state: {
      phase: 'ready',
      working: false,
      view: {
        status: 'ready',
        sky: { lit: 5, of: 7, state: 'forming', finished: 0 },
        starsPerDay: 3,
        stars: [],
      },
    },
  }),
}));

const id = (n: number) => `0199d000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
type Member = Extract<RoomView, { status: 'member' }>;
const person = (n: number, name: string) => ({
  kind: 'person' as const,
  personId: id(n),
  handle: `ci.${name.toLowerCase()}`,
  displayName: name,
});
const face = (n: number, name: string, you = false) => ({ person: person(n, name), you });

const room = {
  roomId: id(1),
  name: 'Space room',
  description: 'Stars, planets, black holes.',
  topic: { kind: 'system' as const, id: 'astronomy', label: 'Astronomy' },
  joinRule: 'open' as const,
  status: 'open' as const,
};
const inhabitants = [
  { inhabitant: 'explainer' as const, name: 'Nova', label: 'AI · Explainer', blurb: 'Answers when asked' },
  { inhabitant: 'skeptic' as const, name: 'Halley', label: 'AI · Skeptic', blurb: 'Pushes back on claims' },
];
const member = (patch: Partial<Member> = {}): Member => ({
  version: 'rooms.v1',
  readId: id(9),
  scope: { accountId: id(2), privacyEpoch: 1 },
  status: 'member',
  room,
  role: 'member',
  hasModerator: false,
  inhabitants,
  general: {
    discussionId: id(5),
    kind: 'general',
    title: 'General',
    pinned: false,
    lastActivityAt: '2026-10-24T08:00:00.000Z',
    replyCount: 0,
  },
  discussions: [],
  canPost: true,
  you: { aiLevel: 'lively', keepOut: false },
  here: { faces: [face(10, 'Ravi', true)] },
  memberTotal: 24,
  sky: { lit: 3, of: 7 as const, state: 'forming' as const, finished: 0 },
  limits: {
    asked: { perPersonPerHour: 10, perRoomPerDay: 80 },
    unprompted: { humanMessagesPerTurn: 3, perHour: 8, perDay: 40, explainerPerHour: 4, skepticPerHour: 3 },
    feed: { postsPerDay: 3, restHours: 6 },
  },
  lastMessageAt: new Date().toISOString(),
  ...patch,
});
const roomState = (patch: Partial<RoomState> = {}): RoomState => ({
  phase: 'member',
  view: undefined,
  offline: false,
  working: false,
  refused: false,
  ...patch,
});
const controller = () =>
  ({
    leave: jest.fn(),
    moderate: jest.fn(),
    startDiscussion: jest.fn(),
    setPreferences: jest.fn(),
  }) as unknown as RoomController & { leave: jest.Mock; setPreferences: jest.Mock };
/** An account scope with the storage the quiet room keeps a put-away offer in (purged with the scope, as the real one is). */
const scopeWithStorage = (): AccountScope => {
  const values = new Map<string, string>();
  return {
    storage: {
      get: (key: string) => values.get(key),
      set: (key: string, value: string) => void values.set(key, value),
      remove: (key: string) => void values.delete(key),
    },
  } as unknown as AccountScope;
};
let scope = scopeWithStorage();
beforeEach(() => {
  scope = scopeWithStorage();
});
const wrap = (node: React.ReactNode) =>
  render(<DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>{node}</DisplayProvider>);

describe('who is here, on the room’s band', () => {
  it('shows two people as named faces and no number', async () => {
    await wrap(
      <HereStrip
        here={{ faces: [face(10, 'Ravi', true), face(11, 'Asha')] }}
        lastMessageAt={new Date().toISOString()}
      />,
    );
    expect(screen.getByTestId(`here-face-${id(10)}`)).toBeOnTheScreen();
    expect(screen.getByTestId(`here-face-${id(11)}`)).toBeOnTheScreen();
    expect(screen.getByText('You and Asha are here')).toBeOnTheScreen();
    expect(screen.queryByText(/online|\d+ here/i)).not.toBeOnTheScreen();
    expect(screen.queryByTestId('quiet-pill')).not.toBeOnTheScreen();
  });

  it('shows a number only from three, and says it plainly', async () => {
    await wrap(
      <HereStrip
        here={{ faces: [face(10, 'Ravi', true), face(11, 'Asha'), face(12, 'Kenji')], count: 4 }}
        lastMessageAt={new Date().toISOString()}
      />,
    );
    expect(screen.getByText('4 here')).toBeOnTheScreen();
  });

  it('is honest when it is quiet: says so and when the last message was', async () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 3_600_000).toISOString();
    await wrap(<HereStrip here={{ faces: [face(10, 'Ravi', true)] }} lastMessageAt={threeHoursAgo} />);
    expect(screen.getByText('Quiet right now · last person wrote 3 h ago')).toBeOnTheScreen();
    expect(screen.queryByText(/online/i)).not.toBeOnTheScreen();
  });

  it('says a room nobody has written in is quiet, and invents no time', async () => {
    await wrap(<HereStrip here={{ faces: [face(10, 'Ravi', true)] }} lastMessageAt={undefined} />);
    expect(screen.getByText('Quiet right now · no one has written yet')).toBeOnTheScreen();
  });

  it('lists the names in D04’s Here now, with a number in the heading only from three', async () => {
    await wrap(<HereNow here={{ faces: [face(10, 'Ravi', true), face(11, 'Asha')] }} />);
    expect(screen.getByText('Here now')).toBeOnTheScreen();
    expect(screen.getByText('Ravi (you)')).toBeOnTheScreen();
    expect(screen.getByText('Asha')).toBeOnTheScreen();
    await wrap(<HereNow here={{ faces: [face(10, 'Ravi', true), face(11, 'Asha'), face(12, 'Kenji')], count: 3 }} />);
    expect(screen.getByText('Here now · 3')).toBeOnTheScreen();
  });
});

describe('the campfire band', () => {
  it('names the room, opens the menu from the name and from the menu button, and never says "online"', async () => {
    const onMenu = jest.fn();
    await wrap(<CampfireHeader view={member()} onBack={jest.fn()} onMenu={onMenu} />);
    expect(screen.getByText('Space room')).toBeOnTheScreen();
    expect(screen.getByTestId('campfire-subline')).toHaveTextContent('Open to everyone');
    await fireEvent.press(screen.getByRole('button', { name: 'Space room, room menu' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Room menu' }));
    expect(onMenu).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/online/i)).not.toBeOnTheScreen();
  });

  it('puts the number of people here in the subline from three', async () => {
    const here = { faces: [face(10, 'Ravi', true), face(11, 'Asha'), face(12, 'Kenji')], count: 3 };
    await wrap(<CampfireHeader view={member({ here })} onBack={jest.fn()} onMenu={jest.fn()} />);
    expect(screen.getByTestId('campfire-subline')).toHaveTextContent('A room · 3 here');
  });
});

describe('General and the AI notice', () => {
  it('lands in General and shows the AI notice until it has been read, once', async () => {
    const c = controller();
    await wrap(<GeneralStage scope={scope} view={member()} controller={c} state={roomState()} header={null} />);
    expect(screen.getByTestId('general-discussion')).toHaveTextContent(id(5));
    expect(screen.getByTestId('ai-notice')).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('ai-notice-ack'));
    expect(c.setPreferences).toHaveBeenCalledWith({ noticeSeen: true });
  });

  it('shows no notice once it has been read: from then on it is only in the room menu', async () => {
    const view = member({ you: { aiLevel: 'lively', keepOut: false, noticeSeenAt: '2026-10-24T08:00:00.000Z' } });
    await wrap(<GeneralStage scope={scope} view={view} controller={controller()} state={roomState()} header={null} />);
    expect(screen.queryByTestId('ai-notice')).not.toBeOnTheScreen();
    expect(screen.getByTestId('general-discussion')).toBeOnTheScreen();
  });

  it('says what AI reads in words that are true today, and where to change it', async () => {
    await wrap(<AiNoticeCard busy={false} onAcknowledge={jest.fn()} />);
    expect(screen.getByText(/always labelled AI/)).toBeOnTheScreen();
    expect(screen.getByText(/without names/)).toBeOnTheScreen();
    expect(screen.getByText(/room menu, AI here/)).toBeOnTheScreen();
  });
});

describe('AI here', () => {
  it('sets Lively, Quieter or Off and the keep-out switch, each on its own', async () => {
    const onChange = jest.fn();
    await wrap(<AiHere you={{ aiLevel: 'lively', keepOut: false }} working={false} onChange={onChange} />);
    expect(screen.getByRole('radio', { name: 'Lively' })).toBeChecked();
    await fireEvent.press(screen.getByRole('radio', { name: 'Quieter' }));
    expect(onChange).toHaveBeenLastCalledWith({ aiLevel: 'quieter' });
    await fireEvent.press(screen.getByRole('radio', { name: 'Off' }));
    expect(onChange).toHaveBeenLastCalledWith({ aiLevel: 'off' });
    await fireEvent.press(screen.getByRole('switch', { name: 'Keep my messages out of what AI reads' }));
    expect(onChange).toHaveBeenLastCalledWith({ keepOut: true });
  });

  it('shows the person’s saved choices, and does not resend the level that is already set', async () => {
    const onChange = jest.fn();
    await wrap(<AiHere you={{ aiLevel: 'off', keepOut: true }} working={false} onChange={onChange} />);
    expect(screen.getByRole('radio', { name: 'Off' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Keep my messages out of what AI reads' })).toBeChecked();
    await fireEvent.press(screen.getByRole('radio', { name: 'Off' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('the room menu', () => {
  const pinned = {
    discussionId: id(11),
    kind: 'topic' as const,
    title: 'Pinned question',
    pinned: true,
    lastActivityAt: '2026-10-24T07:00:00.000Z',
    replyCount: 0,
  };
  const open = (view: Member, c = controller()) =>
    wrap(
      <RoomMenu
        scope={scope}
        view={view}
        controller={c}
        state={roomState()}
        visible
        onClose={jest.fn()}
        onShare={jest.fn()}
      />,
    );

  it('lists About, Guidelines, AI here, Members with the total, Pins and Topics', async () => {
    await open(member({ discussions: [pinned, { ...pinned, discussionId: id(12), pinned: false, title: 'Other' }] }));
    for (const testID of ['menu-about', 'menu-guidelines', 'menu-ai', 'menu-members', 'menu-pins', 'menu-topics'])
      expect(screen.getByTestId(testID)).toBeOnTheScreen();
    expect(screen.getByTestId('menu-members')).toHaveTextContent('Members24');
    expect(screen.getByTestId('menu-pins')).toHaveTextContent('Pins1');
    expect(screen.getByTestId('menu-topics')).toHaveTextContent('Topics2');
    expect(screen.getByTestId('menu-ai')).toHaveTextContent('AI hereLively');
    expect(screen.queryByTestId('menu-moderation')).not.toBeOnTheScreen();
  });

  it('has a Today row and a Room sky row: the way to both once the Now strip has scrolled out of view', async () => {
    mockPush.mockClear();
    await open(
      member({
        today: { discussionId: id(20), prompt: 'Why is the night sky dark?', flaw: true },
        sky: { lit: 5, of: 7 as const, state: 'forming' as const, finished: 0 },
      }),
    );
    expect(screen.getByTestId('menu-sky')).toHaveTextContent('Room sky5 of 7');
    // Today opens the day's channel.
    await fireEvent.press(screen.getByTestId('menu-today'));
    expect(mockPush).toHaveBeenCalledWith(`/rooms/${id(1)}/today`);
    // The sky opens in place, with its way back to the menu.
    await fireEvent.press(screen.getByTestId('menu-sky'));
    expect(screen.getByTestId('sky-line')).toHaveTextContent('5 of 7 stars');
    await fireEvent.press(screen.getByRole('button', { name: 'Back to the room menu' }));
    expect(screen.getByTestId('menu-sky')).toBeOnTheScreen();
  });

  it('has no Today row until an operator approved something, and keeps the Room sky row', async () => {
    await open(member());
    expect(screen.queryByTestId('menu-today')).not.toBeOnTheScreen();
    expect(screen.getByTestId('menu-sky')).toBeOnTheScreen();
  });

  it('keeps the AI notice, and the person’s choices, under AI here', async () => {
    const c = controller();
    await open(member({ you: { aiLevel: 'quieter', keepOut: false, noticeSeenAt: '2026-10-24T08:00:00.000Z' } }), c);
    await fireEvent.press(screen.getByTestId('menu-ai'));
    expect(screen.getByRole('radio', { name: 'Quieter' })).toBeChecked();
    expect(screen.getByText(/always labelled AI/)).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('switch', { name: 'Keep my messages out of what AI reads' }));
    expect(c.setPreferences).toHaveBeenCalledWith({ keepOut: true });
  });

  it('opens Pins and Topics as lists, and says honestly when there is nothing', async () => {
    await open(member());
    await fireEvent.press(screen.getByTestId('menu-pins'));
    expect(screen.getByText('Nothing pinned')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Back to the room menu' }));
    await fireEvent.press(screen.getByTestId('menu-topics'));
    expect(screen.getByText('Nothing here yet')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Share into room' })).not.toBeOnTheScreen();
  });

  it('closes the menu before a topic opens, so the sheet never stays over the topic', async () => {
    mockPush.mockClear();
    const onClose = jest.fn();
    const topic = { ...pinned, discussionId: id(12), pinned: false, title: 'Why is the night sky dark?' };
    await wrap(
      <RoomMenu
        scope={scope}
        view={member({ discussions: [topic] })}
        controller={controller()}
        state={roomState()}
        visible
        onClose={onClose}
        onShare={jest.fn()}
      />,
    );
    await fireEvent.press(screen.getByTestId('menu-topics'));
    await fireEvent.press(screen.getByTestId(`discussion-${topic.discussionId}`));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith(`/rooms/${id(1)}/t/${topic.discussionId}`);
  });

  it('shows the written guidelines, or says there are none', async () => {
    await open(member({ guidelines: 'Be kind. Say where an idea came from.' }));
    await fireEvent.press(screen.getByTestId('menu-guidelines'));
    expect(screen.getByText('Be kind. Say where an idea came from.')).toBeOnTheScreen();
  });

  it('gives a moderator the moderation page and nobody else', async () => {
    await open(member({ role: 'moderator', hasModerator: true }));
    await fireEvent.press(screen.getByTestId('menu-moderation'));
    expect(screen.getByText('Moderator tools')).toBeOnTheScreen();
  });

  it('leaves the room from the menu', async () => {
    const c = controller();
    await open(member(), c);
    await fireEvent.press(screen.getByTestId('leave-room'));
    expect(c.leave).toHaveBeenCalledTimes(1);
  });
});

describe('the Launch in the room', () => {
  type ReadyLaunch = Extract<RoomLaunch, { status: 'ready' }>;
  const players = [{ person: person(10, 'Ravi'), you: true }];
  const lobby: LaunchView = { phase: 'lobby', launchId: id(70), startsInMs: 12_000, players, youIn: true };
  const finished: LaunchView = {
    phase: 'finished',
    launchId: id(70),
    played: 2,
    podium: [{ place: 1, score: 3, person: person(10, 'Ravi'), blockedByYou: false, you: true }],
    you: { score: 3, squares: [true, true, true, false, false], place: 1 },
    star: true,
    day: '2026-10-26',
    youIn: true,
  };
  const serve = (launch: LaunchView | undefined, start?: ReadyLaunch['start'], actions: object = {}) => {
    mockLaunch.current = {
      controller: actions,
      state: {
        phase: 'ready',
        view: {
          status: 'ready',
          host: LAUNCH_HOST,
          ...(launch === undefined ? {} : { launch }),
          ...(start === undefined ? {} : { start }),
        } as unknown as ReadyLaunch,
        receivedAt: 0,
        offline: false,
        working: false,
        refused: false,
        notSaved: undefined,
        recordingPaused: false,
      },
    };
  };
  const stage = (view: Member) => (
    <GeneralStage scope={scope} view={view} controller={controller()} state={roomState()} header={null} />
  );

  it('puts the stage above General while a Launch is on, with the conversation still there as the crowd, and a mark on the band', async () => {
    serve(lobby);
    const view = member({
      launch: { state: 'lobby' },
      you: { aiLevel: 'lively', keepOut: false, noticeSeenAt: '2026-10-24T08:00:00.000Z' },
    });
    await wrap(stage(view));
    expect(screen.getByTestId('launch-stage')).toBeOnTheScreen();
    expect(screen.getByTestId('general-discussion')).toHaveTextContent(id(5));
    await wrap(<CampfireHeader view={view} onBack={jest.fn()} onMenu={jest.fn()} />);
    expect(screen.getByTestId('band-live')).toBeOnTheScreen();
    expect(screen.getByLabelText('A Launch is live')).toBeOnTheScreen();
  });

  it('shows no stage and no mark when there is no Launch, and no mark for one that can only start', async () => {
    serve(undefined);
    await wrap(stage(member({ launch: { state: 'ready' } })));
    expect(screen.queryByTestId('launch-stage')).not.toBeOnTheScreen();
    await wrap(<CampfireHeader view={member({ launch: { state: 'ready' } })} onBack={jest.fn()} onMenu={jest.fn()} />);
    expect(screen.queryByTestId('band-live')).not.toBeOnTheScreen();
  });

  it('opens the start sheet from the chip when one can start, and starts it from there', async () => {
    const actions = { start: jest.fn(() => Promise.resolve(true)), load: jest.fn() };
    serve(undefined, { allowed: true }, actions);
    await wrap(stage(member({ launch: { state: 'ready' } })));
    await fireEvent.press(screen.getByTestId('now-launch'));
    expect(actions.load).toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('launch-start'));
    expect(actions.start).toHaveBeenCalledTimes(1);
  });

  it('opens the podium by itself for someone who watched the Launch end, and not for someone who arrives after it', async () => {
    serve(lobby);
    const view = member({ launch: { state: 'live' } });
    const { rerender } = await wrap(stage(view));
    serve(finished);
    await rerender(
      <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
        {stage(member({ launch: { state: 'finished' } }))}
      </DisplayProvider>,
    );
    expect(screen.getByTestId('launch-podium')).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('launch-close'));
    expect(screen.queryByTestId('launch-podium')).not.toBeOnTheScreen();
    // The chip brings it back for anyone, as many times as they like.
    await fireEvent.press(screen.getByTestId('now-launch'));
    expect(screen.getByTestId('launch-podium')).toBeOnTheScreen();
  });

  it('does not pop the podium for a Launch that was over before this screen saw it', async () => {
    serve(finished);
    await wrap(stage(member({ launch: { state: 'finished' } })));
    expect(screen.queryByTestId('launch-podium')).not.toBeOnTheScreen();
    expect(screen.getByTestId('now-launch')).toHaveTextContent(/Podium/);
  });
});

describe('the quiet room', () => {
  const READ = { noticeSeenAt: '2026-10-24T08:00:00.000Z' };
  const quietFor = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
  const stageOf = (
    view: Member,
    actions: Partial<Record<'setQuestionNotice' | 'leaveQuestion', jest.Mock>> = {},
    inScope: AccountScope = scope,
  ) => (
    <GeneralStage
      scope={inScope}
      view={view}
      controller={{ ...controller(), ...actions }}
      state={roomState()}
      header={null}
    />
  );
  const quietView = (day: string, patch: Partial<Member> = {}) =>
    member({
      you: { aiLevel: 'lively', keepOut: false, ...READ },
      lastMessageAt: quietFor(3),
      replay: { day },
      ...patch,
    });

  it('offers a warm-up as the host, labelled AI, in a room nobody has written in for hours that has a Launch to replay', async () => {
    await wrap(stageOf(quietView('2026-10-20')));
    expect(screen.getByTestId('quiet-offer')).toBeOnTheScreen();
    expect(screen.getByLabelText('AI, Quizmaster')).toBeOnTheScreen();
    expect(screen.getByTestId('quiet-offer-line')).toHaveTextContent(/Launch of 20 Oct/);
    // The chip is there too, for whoever does not want a card.
    expect(screen.getByTestId('now-replay')).toHaveTextContent(/Launch of 20 Oct/);
  });

  it('offers it once: Not now puts it away, and the chip stays', async () => {
    await wrap(stageOf(quietView('2026-10-21')));
    await fireEvent.press(screen.getByTestId('quiet-offer-dismiss'));
    expect(screen.queryByTestId('quiet-offer')).not.toBeOnTheScreen();
    expect(screen.getByTestId('now-replay')).toBeOnTheScreen();
  });

  it('puts the offer away for that room and night only, and a new account scope is offered it again', async () => {
    const day = '2026-10-29';
    const otherRoom = { ...room, roomId: id(2) };
    const { rerender } = await wrap(stageOf(quietView(day)));
    await fireEvent.press(screen.getByTestId('quiet-offer-dismiss'));
    expect(screen.queryByTestId('quiet-offer')).not.toBeOnTheScreen();
    // Another room, the same night: it is that room's offer, not this one's.
    await rerender(
      <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
        {stageOf(quietView(day, { room: otherRoom }))}
      </DisplayProvider>,
    );
    expect(screen.getByTestId('quiet-offer')).toBeOnTheScreen();
    // The first room is still put away in this scope; after an account switch (a new scope) it is offered again.
    await rerender(
      <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
        {stageOf(quietView(day))}
      </DisplayProvider>,
    );
    expect(screen.queryByTestId('quiet-offer')).not.toBeOnTheScreen();
    await rerender(
      <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
        {stageOf(quietView(day), {}, scopeWithStorage())}
      </DisplayProvider>,
    );
    expect(screen.getByTestId('quiet-offer')).toBeOnTheScreen();
  });

  it('opens the replay from the offer and from the chip', async () => {
    await wrap(stageOf(quietView('2026-10-22')));
    expect(screen.queryByTestId('replay-sheet')).not.toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('quiet-offer-replay'));
    expect(screen.getByTestId('replay-sheet')).toBeOnTheScreen();
    expect(screen.getByTestId('replay-banner')).toHaveTextContent(/^Replay./);
    expect(screen.queryByTestId('quiet-offer')).not.toBeOnTheScreen();
  });

  it('makes no offer while people are talking, and none when there is nothing to replay', async () => {
    await wrap(stageOf(quietView('2026-10-23', { lastMessageAt: new Date().toISOString() })));
    expect(screen.queryByTestId('quiet-offer')).not.toBeOnTheScreen();
    expect(screen.getByTestId('now-replay')).toBeOnTheScreen();
    await wrap(stageOf(quietView('2026-10-24', { replay: undefined })));
    expect(screen.queryByTestId('quiet-offer')).not.toBeOnTheScreen();
    expect(screen.queryByTestId('now-replay')).not.toBeOnTheScreen();
  });

  it('tells the person who left a question that a person answered it, and takes the notice away when they say so', async () => {
    const setQuestionNotice = jest.fn(() => Promise.resolve(true));
    const reply = {
      discussionId: id(60),
      title: 'How do astronomers know how far away a star is?',
      by: person(61, 'Lena'),
      askedAt: '2026-10-26T21:14:00.000Z',
      at: '2026-10-28T21:20:00.000Z',
    };
    await wrap(
      stageOf(quietView('2026-10-25', { questions: { waiting: 0, replies: [reply] } }), { setQuestionNotice }),
    );
    expect(screen.getByTestId('question-reply-line')).toHaveTextContent(/Lena answered your question · 2 days later/);
    await fireEvent.press(screen.getByTestId('question-reply-dismiss'));
    expect(setQuestionNotice).toHaveBeenCalledWith(id(60), { noticed: true });
  });

  it('opens the answer from the notice, after saying it was seen', async () => {
    mockPush.mockClear();
    const setQuestionNotice = jest.fn(() => Promise.resolve(true));
    const reply = {
      discussionId: id(62),
      title: 'Why is the night sky dark?',
      by: person(61, 'Lena'),
      askedAt: '2026-10-26T21:14:00.000Z',
      at: '2026-10-26T21:20:00.000Z',
    };
    await wrap(
      stageOf(quietView('2026-10-26', { questions: { waiting: 0, replies: [reply] } }), { setQuestionNotice }),
    );
    await fireEvent.press(screen.getByTestId('question-reply-read'));
    expect(setQuestionNotice).toHaveBeenCalledWith(id(62), { noticed: true });
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith(`/rooms/${id(1)}/t/${id(62)}`));
  });

  it('counts the questions that wait for a person in the strip, and offers the shelf from it', async () => {
    await wrap(stageOf(quietView('2026-10-27', { questions: { waiting: 3, replies: [] } })));
    expect(screen.getByTestId('now-questions')).toHaveTextContent(/3 questions waiting/);
    await fireEvent.press(screen.getByTestId('now-questions'));
    expect(screen.getByTestId('questions-sheet')).toBeOnTheScreen();
  });
});

describe('Watch together in the room', () => {
  const reel = { assetId: id(80), assetRevision: 1, title: 'How big is the universe?', durationMs: 70_000 };
  const session = {
    phase: 'playing' as const,
    sessionId: id(81),
    reel,
    youIn: false,
    canStop: false,
    elapsedMs: 5_000,
  };
  const serve = (view: object | undefined, actions: object = {}) => {
    mockWatch.current = {
      controller: { load: jest.fn(), loadReels: jest.fn(), start: jest.fn(), ...actions },
      state: {
        phase: 'ready',
        view: view === undefined ? undefined : { status: 'ready', readId: id(9), ...view },
        receivedAt: 0,
        reels: undefined,
        reelsFailed: false,
        offline: false,
        working: false,
        refused: false,
        recordingPaused: false,
        notSaved: undefined,
      },
    };
  };
  const stage = (view: Member) => (
    <GeneralStage scope={scope} view={view} controller={controller()} state={roomState()} header={null} />
  );
  const seen = { you: { aiLevel: 'lively' as const, keepOut: false, noticeSeenAt: '2026-10-24T08:00:00.000Z' } };

  it('puts the stage above General while a Reel is on, with the conversation still there as the crowd, and a mark on the band', async () => {
    serve({ session });
    const view = member({ ...seen, watch: { state: 'live' } });
    await wrap(stage(view));
    expect(screen.getByTestId('watch-stage')).toBeOnTheScreen();
    expect(screen.getByTestId('general-discussion')).toHaveTextContent(id(5));
    await wrap(<CampfireHeader view={view} onBack={jest.fn()} onMenu={jest.fn()} />);
    expect(screen.getByTestId('band-live')).toBeOnTheScreen();
    expect(screen.getByLabelText('A Reel is being watched together')).toBeOnTheScreen();
    expect(screen.getByText('LIVE · REEL')).toBeOnTheScreen();
  });

  it('shows no stage and no mark when nothing is on, and offers the chip only while a Reel can be started', async () => {
    serve({ start: { allowed: true } });
    await wrap(stage(member({ ...seen, watch: { state: 'ready' } })));
    expect(screen.queryByTestId('watch-stage')).not.toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Watch together, Start a Reel' })).toBeOnTheScreen();
    await wrap(<CampfireHeader view={member({ watch: { state: 'ready' } })} onBack={jest.fn()} onMenu={jest.fn()} />);
    expect(screen.queryByTestId('band-live')).not.toBeOnTheScreen();
  });

  it('draws no chip in a room whose topic has no Reel, and none while one is on (the stage says so)', async () => {
    serve(undefined);
    await wrap(stage(member(seen)));
    expect(screen.queryByTestId('now-watch')).not.toBeOnTheScreen();
    serve({ session });
    await wrap(stage(member({ ...seen, watch: { state: 'live' } })));
    expect(screen.queryByTestId('now-watch')).not.toBeOnTheScreen();
  });

  it('says "Nothing on stage right now" from the chip, reads the Reels when asked, and starts one from there', async () => {
    const actions = { start: jest.fn(() => Promise.resolve(true)), loadReels: jest.fn() };
    serve({ start: { allowed: true }, last: { kind: 'launch', at: '2026-10-25T21:30:00.000Z' } }, actions);
    mockWatch.current.state = { ...mockWatch.current.state, reels: [reel] };
    await wrap(stage(member({ ...seen, watch: { state: 'ready' } })));
    await fireEvent.press(screen.getByTestId('now-watch'));
    expect(screen.getByText('Nothing on stage right now')).toBeOnTheScreen();
    expect(screen.getByTestId('watch-last')).toHaveTextContent(/^Last on stage: the Launch, /);
    await fireEvent.press(screen.getByTestId('watch-choose'));
    expect(actions.loadReels).toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId(`watch-reel-${reel.assetId}`));
    expect(actions.start).toHaveBeenCalledWith(reel.assetId);
  });
});
