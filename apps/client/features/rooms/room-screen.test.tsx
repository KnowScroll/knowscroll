import type * as React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import type {
  AccountScope,
  RoomActivitiesController,
  RoomActivitiesState,
  RoomController,
  RoomState,
} from '@knowscroll/client-core';
import type { RoomView } from '@knowscroll/contracts';
import { DisplayProvider } from '@knowscroll/ui';
import { MemberBody, PreviewBody } from './room-screen';
import { RoomRow, roomRowSubtitle } from './room-row';

const mockPush = jest.fn();
jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof React>('react');
  return {
    useRouter: () => ({ navigate: jest.fn(), push: mockPush, replace: jest.fn(), canGoBack: () => false }),
    useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]),
  };
});

const mockActivities = jest.fn<{ controller: RoomActivitiesController; state: RoomActivitiesState }, []>();
jest.mock('./use-room', () => ({
  ...jest.requireActual<object>('./use-room'),
  useRoomActivities: () => mockActivities(),
}));
const activitiesState = (patch: Partial<RoomActivitiesState> = {}) => ({
  controller: { load: jest.fn(), create: jest.fn() } as unknown as RoomActivitiesController,
  state: {
    phase: 'ready',
    activities: [],
    canCreate: false,
    offline: false,
    working: false,
    refused: false,
    ...patch,
  } satisfies RoomActivitiesState,
});

const id = (n: number) => `0199d000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const room = {
  roomId: id(1),
  name: 'Machine learning room',
  description: 'How computers learn patterns from data.',
  topic: { kind: 'system' as const, id: 'machine-learning', label: 'Machine learning' },
  joinRule: 'open' as const,
  status: 'open' as const,
};
const inhabitants = [
  { inhabitant: 'explainer' as const, name: 'Nova', label: 'AI · Explainer', blurb: 'Answers when asked' },
  { inhabitant: 'skeptic' as const, name: 'Halley', label: 'AI · Skeptic', blurb: 'Pushes back on claims' },
];
type Preview = Extract<RoomView, { status: 'preview' }>;
type Member = Extract<RoomView, { status: 'member' }>;
const preview = (patch: Partial<Preview> = {}): Preview => ({
  version: 'rooms.v1',
  readId: id(9),
  scope: { accountId: id(2), privacyEpoch: 1 },
  status: 'preview',
  room,
  hasModerator: false,
  inhabitants,
  invited: false,
  join: { allowed: true },
  ...patch,
});
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
  },
  discussions: [],
  canPost: true,
  you: { aiLevel: 'lively', keepOut: false, noticeSeenAt: '2026-10-24T08:00:00.000Z' },
  here: { faces: [] },
  memberTotal: 3,
  ...patch,
});
const roomState = (patch: Partial<RoomState> = {}): RoomState => ({
  phase: 'preview',
  view: undefined,
  offline: false,
  working: false,
  refused: false,
  ...patch,
});
const controller = () =>
  ({
    join: jest.fn(),
    leave: jest.fn(),
    moderate: jest.fn(),
    startDiscussion: jest.fn(),
  }) as unknown as RoomController & {
    join: jest.Mock;
    leave: jest.Mock;
    moderate: jest.Mock;
  };

const wrap = (node: React.ReactNode) =>
  render(<DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>{node}</DisplayProvider>);

describe('a room preview (R01)', () => {
  it('shows who is here to help, labels the AI inhabitants, counts nobody, and joins on request', async () => {
    const c = controller();
    await wrap(<PreviewBody view={preview({ hasModerator: true })} controller={c} state={roomState()} />);
    expect(screen.getByText('How computers learn patterns from data.')).toBeOnTheScreen();
    expect(screen.getAllByRole('text', { name: 'Moderator' }).length).toBeGreaterThan(0);
    expect(screen.getByRole('text', { name: 'AI, Explainer' })).toBeOnTheScreen();
    expect(screen.getByText('AI inhabitants are labelled and never pretend to be people.')).toBeOnTheScreen();
    expect(screen.getByText('Joining doesn’t change your universe.')).toBeOnTheScreen();
    expect(screen.queryByText(/members|online|active/i)).not.toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Join room' }));
    expect(c.join).toHaveBeenCalledTimes(1);
  });

  it('shows no moderator line when the room has none', async () => {
    await wrap(<PreviewBody view={preview()} controller={controller()} state={roomState()} />);
    expect(screen.queryAllByRole('text', { name: 'Moderator' })).toHaveLength(0);
  });

  it.each([
    ['invite_only', 'This room is invite-only. Ask a member.'],
    ['friend_of_member_needed', 'A friend of a member can join'],
    ['profile_needed', 'Choose a name first'],
    ['paused', 'Paused by the moderator'],
    ['closed', 'This room is closed'],
    ['removed', 'You’re no longer a member'],
  ] as const)('says plainly why a person cannot join (%s) and offers no Join button', async (reason, title) => {
    await wrap(
      <PreviewBody
        view={preview({ join: { allowed: false, reason } })}
        controller={controller()}
        state={roomState()}
      />,
    );
    expect(screen.getByText(title)).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Join room' })).not.toBeOnTheScreen();
  });

  it('points an invite-only visitor to a friend, not to a request that goes nowhere', async () => {
    mockPush.mockClear();
    await wrap(
      <PreviewBody
        view={preview({ join: { allowed: false, reason: 'invite_only' } })}
        controller={controller()}
        state={roomState()}
      />,
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Message a friend' }));
    expect(mockPush).toHaveBeenCalledWith('/conversations');
  });
});

describe('a room as a member (R02)', () => {
  const scope = {} as AccountScope;
  beforeEach(() => mockActivities.mockReturnValue(activitiesState()));
  const discussions = [
    {
      discussionId: id(10),
      kind: 'topic' as const,
      title: 'Offline inference',
      pinned: false,
      lastActivityAt: '2026-10-24T08:00:00.000Z',
    },
    {
      discussionId: id(11),
      kind: 'topic' as const,
      title: 'What one answer costs to serve',
      pinned: true,
      lastActivityAt: '2026-10-24T07:00:00.000Z',
      root: {
        status: 'available' as const,
        target: { assetId: id(30), assetRevision: 1 },
        metadata: { kind: 'reel' as const, title: 'What one answer costs', summary: '', language: 'en' },
      },
      startedBy: { kind: 'person' as const, personId: id(40), handle: 'ci.ravi', displayName: 'Ravi' },
    },
  ];

  it('lists the discussions with the pinned one marked, and opens one', async () => {
    mockPush.mockClear();
    await wrap(
      <MemberBody scope={scope} view={member({ discussions })} controller={controller()} state={roomState()} />,
    );
    expect(screen.getByText('Pinned by the moderator')).toBeOnTheScreen();
    expect(screen.getByText('Reel · started by Ravi')).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId(`discussion-${id(11)}`));
    expect(mockPush).toHaveBeenCalledWith(`/rooms/${id(1)}/t/${id(11)}`);
  });

  it('says honestly that a room with nothing in it is empty, and never fills it', async () => {
    await wrap(<MemberBody scope={scope} view={member()} controller={controller()} state={roomState()} />);
    expect(screen.getByText('Nothing here yet')).toBeOnTheScreen();
  });

  it('shows moderator tools only to a moderator, and a paused room as read-only', async () => {
    const c = controller();
    await wrap(
      <MemberBody
        scope={scope}
        view={member({ role: 'moderator', hasModerator: true, canPost: false, room: { ...room, status: 'paused' } })}
        controller={c}
        state={roomState()}
      />,
    );
    expect(screen.getByText('Moderator tools')).toBeOnTheScreen();
    expect(screen.getByText('Paused by the moderator.')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Share into room' })).not.toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Resume the room' }));
    expect(c.moderate).toHaveBeenCalledWith({ kind: 'resume' });
  });

  it('hides the moderator tools from an ordinary member', async () => {
    await wrap(<MemberBody scope={scope} view={member()} controller={controller()} state={roomState()} />);
    expect(screen.queryByText('Moderator tools')).not.toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Share into room' })).toBeOnTheScreen();
  });
});

describe('a room’s optional activity (R03) on its page', () => {
  const scope = {} as AccountScope;
  const poll = {
    activityId: id(50),
    kind: 'poll' as const,
    title: 'At 10x requests, what would you try first?',
    state: 'open' as const,
    startedAt: '2026-10-24T08:00:00.000Z',
    voted: true,
  };
  const quiz = { ...poll, activityId: id(51), kind: 'quiz' as const, title: 'Room quiz', voted: undefined };

  it('shows nothing at all when there is nothing and the person is not a moderator', async () => {
    mockActivities.mockReturnValue(activitiesState());
    await wrap(<MemberBody scope={scope} view={member()} controller={controller()} state={roomState()} />);
    expect(screen.queryByTestId('room-activities')).not.toBeOnTheScreen();
    expect(screen.queryByText('Optional')).not.toBeOnTheScreen();
  });

  it('lists the polls and quizzes as optional, says whether the person voted, and opens one', async () => {
    mockPush.mockClear();
    mockActivities.mockReturnValue(activitiesState({ activities: [poll, quiz] }));
    await wrap(<MemberBody scope={scope} view={member()} controller={controller()} state={roomState()} />);
    expect(screen.getByText('Room activity')).toBeOnTheScreen();
    expect(screen.getByText('Poll · Optional · You voted')).toBeOnTheScreen();
    expect(screen.getByText('Quiz · Optional')).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId(`activity-${id(50)}`));
    expect(mockPush).toHaveBeenCalledWith(`/rooms/${id(1)}/activity/${id(50)}`);
    // No count, no badge, no "new".
    expect(screen.queryByText(/new|unread|\d+ (polls|quizzes)/i)).not.toBeOnTheScreen();
  });

  it('gives a moderator the two ways to start one, and nobody else', async () => {
    mockActivities.mockReturnValue(activitiesState({ canCreate: true }));
    await wrap(
      <MemberBody scope={scope} view={member({ role: 'moderator' })} controller={controller()} state={roomState()} />,
    );
    expect(screen.getByRole('button', { name: 'Start a poll' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Start a quiz' })).toBeOnTheScreen();
    expect(screen.getByText('Nothing open. Nobody has to join in.')).toBeOnTheScreen();
  });

  it('leaves the activity out of D04’s left pane, which has a pane of its own for it', async () => {
    mockActivities.mockReturnValue(activitiesState({ activities: [poll] }));
    await wrap(<MemberBody scope={scope} view={member()} controller={controller()} state={roomState()} rail />);
    expect(screen.queryByTestId('room-activities')).not.toBeOnTheScreen();
  });
});

describe('a room in Talk', () => {
  it('words a joined room and an invitation without any count or activity, and opens the room', async () => {
    mockPush.mockClear();
    expect(roomRowSubtitle({ room, standing: 'member' })).toBe('A room about machine learning');
    expect(roomRowSubtitle({ room, standing: 'invited' })).toBe('You’re invited to this room');
    expect(roomRowSubtitle({ room: { ...room, status: 'paused' }, standing: 'moderator' })).toBe('A room · paused');
    await wrap(<RoomRow item={{ room, standing: 'invited' }} />);
    expect(screen.getByText('Invited')).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId(`talk-room-${id(1)}`));
    expect(mockPush).toHaveBeenCalledWith(`/rooms/${id(1)}`);
  });
});
