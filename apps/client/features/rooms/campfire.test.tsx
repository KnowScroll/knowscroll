import type * as React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import type { AccountScope, RoomController, RoomState } from '@knowscroll/client-core';
import type { RoomView } from '@knowscroll/contracts';
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
  OpenDiscussion: ({ discussionId }: { discussionId: string }) => {
    const { Text } = jest.requireActual<{ Text: React.ComponentType<{ testID: string; children: string }> }>(
      'react-native',
    );
    return <Text testID="general-discussion">{discussionId}</Text>;
  },
}));
jest.mock('./use-room', () => ({
  ...jest.requireActual<object>('./use-room'),
  useRoomActivities: () => ({ controller: {}, state: { activities: [], canCreate: false } }),
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
const scope = {} as AccountScope;
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
    expect(screen.getByText('Quiet right now · last message 3 h ago')).toBeOnTheScreen();
    expect(screen.queryByText(/online/i)).not.toBeOnTheScreen();
  });

  it('says a room nobody has written in is quiet, and invents no time', async () => {
    await wrap(<HereStrip here={{ faces: [face(10, 'Ravi', true)] }} lastMessageAt={undefined} />);
    expect(screen.getByText('Quiet right now · no messages yet')).toBeOnTheScreen();
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
