import type * as React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import type { RoomFeedController, RoomFeedState } from '@knowscroll/client-core';
import type { RoomFeed, RoomFeedPost, RoomScout } from '@knowscroll/contracts';
import { DisplayProvider } from '@knowscroll/ui';
import { RoomFeedPanel } from './feed-screen';
import { FeedPost } from './feed-post';
import { ScoutSheet } from './scout-sheet';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ navigate: jest.fn(), push: mockPush, replace: jest.fn(), canGoBack: () => false }),
}));
const mockFeed: { current: { controller: Partial<RoomFeedController>; state: RoomFeedState } } = {
  current: {
    controller: {},
    state: {
      phase: 'loading',
      view: undefined,
      sort: 'hot',
      window: 'week',
      offline: false,
      working: false,
      refused: false,
    },
  },
};
jest.mock('./use-room', () => ({
  useRoomFeed: () => mockFeed.current,
  useRoomSky: () => ({ controller: {}, state: {} }),
}));
jest.mock('../../providers/account-scope', () => ({
  useAccountScope: () => ({ state: { status: 'signed_in', scope: { active: true } } }),
}));
jest.mock('../../platform/document-title', () => ({ useDocumentTitle: () => undefined }));

const id = (n: number) => `0199e000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const roomId = id(1);
const kit = {
  version: 'room-kit.v1',
  palette: { ground: 'midnight', accent: 'sun', ink: 'cream' },
  emblem: { frame: 'circle', glyph: 'ringed-planet' },
  motif: 'constellation',
  motion: 'twinkle',
  cast: { explainer: 'star', skeptic: 'hourglass' },
} as unknown as Extract<RoomFeed, { status: 'ready' }>['identity']['kit'];
const identity = { kit };
const asha = { kind: 'person' as const, personId: id(2), handle: 'asha', displayName: 'Asha' };
const scoutAuthor = { kind: 'agent' as const, sentBy: asha, label: 'AI · Scout' as const };
const choices = [
  { id: 'a', label: 'Attention' },
  { id: 'b', label: 'Training' },
  { id: 'c', label: 'Efficiency' },
  { id: 'd', label: 'Transformers' },
  { id: 'e', label: 'Tokens' },
  { id: 'f', label: 'Scaling' },
];
const none: RoomScout = { state: 'none', choices };
const on = (over: Partial<Extract<RoomScout, { state: 'on' }>> = {}): RoomScout => ({
  state: 'on',
  choices,
  interests: ['a'],
  cadence: 'daily',
  paused: false,
  stopped: false,
  ...over,
});
const post = (
  patch: Partial<Extract<RoomFeedPost, { kind: 'find' }>> = {},
): Extract<RoomFeedPost, { kind: 'find' }> => ({
  kind: 'find',
  votes: 0,
  youVoted: false,
  canVote: true,
  discussionId: id(3),
  author: scoutAuthor,
  postedAt: new Date(Date.now() - 3_600_000).toISOString(),
  content: {
    status: 'available',
    target: { assetId: id(40), assetRevision: 1 },
    metadata: { kind: 'scroll', title: 'Weighing the Milky Way’s invisible halo', summary: 'Part 2.', language: 'en' },
  },
  note: 'A short walk through how the halo is weighed.',
  replies: 0,
  ...patch,
});
const feed = (patch: Partial<Extract<RoomFeed, { status: 'ready' }>> = {}): Extract<RoomFeed, { status: 'ready' }> => ({
  version: 'rooms.v1',
  readId: id(2),
  scope: { accountId: id(9), privacyEpoch: 1 },
  status: 'ready',
  roomId,
  roomName: 'Space room',
  profiles: [],
  identity,
  posts: [],
  residents: [],
  memory: { state: 'none' },
  canEditMemory: false,
  aiLevel: 'lively',
  sort: 'hot',
  window: 'week',
  canPost: true,
  limits: { postsPerDay: 3, restHours: 6, memberPostsPerDay: 3 },
  ...patch,
});
const wrap = (node: React.ReactNode) =>
  render(<DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>{node}</DisplayProvider>);
const show = (view: Extract<RoomFeed, { status: 'ready' }>, controller: Partial<RoomFeedController> = {}) => {
  mockFeed.current = {
    controller,
    state: { phase: 'ready', view, sort: 'hot', window: 'week', offline: false, working: false, refused: false },
  };
  return wrap(<RoomFeedPanel scope={{ active: true } as never} roomId={roomId} />);
};

beforeEach(() => mockPush.mockClear());

describe('a scout’s find in the feed', () => {
  it('is signed with its owner’s name, labelled AI, and read as an article that says both', async () => {
    await wrap(
      <FeedPost post={post()} identity={identity} now={new Date()} href="/x" onOpen={jest.fn()} onVote={jest.fn()} />,
    );
    expect(screen.getByText('Asha’s scout')).toBeOnTheScreen();
    expect(screen.getByLabelText('AI, Scout')).toBeOnTheScreen();
    expect(screen.getByTestId('feed-post-signature')).toHaveTextContent('Sent by Asha');
    expect(screen.getByTestId('feed-post-mark', { includeHiddenElements: true }).props['aria-hidden']).toBe(true);
    expect(screen.getByTestId('feed-post-note')).toHaveTextContent('A short walk through how the halo is weighed.');
    expect(screen.getByText('Open Scroll')).toBeOnTheScreen();
    const article = screen.getByTestId(`feed-post-${id(3)}`);
    expect(article.props.accessibilityLabel).toMatch(
      /^Asha’s scout, AI, Scout, Sent by Asha, found a Scroll: Weighing the Milky Way/,
    );
  });

  it('never says its owner watched or read anything', async () => {
    await wrap(
      <FeedPost post={post()} identity={identity} now={new Date()} href="/x" onOpen={jest.fn()} onVote={jest.fn()} />,
    );
    expect(screen.queryByText(/while .* away|watched|read it/i)).not.toBeOnTheScreen();
  });

  it('has no way to stop it for a reader who is not a moderator', async () => {
    await wrap(
      <FeedPost post={post()} identity={identity} now={new Date()} href="/x" onOpen={jest.fn()} onVote={jest.fn()} />,
    );
    expect(screen.queryByTestId('feed-post-stop-scout')).not.toBeOnTheScreen();
  });

  it('gives a moderator a way to stop it, naming the person who sent it', async () => {
    const stop = jest.fn();
    await wrap(
      <FeedPost
        post={post()}
        identity={identity}
        now={new Date()}
        href="/x"
        onOpen={jest.fn()}
        onVote={jest.fn()}
        onStopScout={stop}
      />,
    );
    await fireEvent.press(screen.getByTestId('feed-post-stop-scout'));
    expect(stop).toHaveBeenCalledWith(asha.personId);
  });

  it('holds the note back for a Quieter reader, naming the scout and not the owner’s words', async () => {
    const { note: _note, ...quiet } = post();
    await wrap(
      <FeedPost
        post={{ ...quiet, folded: true }}
        identity={identity}
        now={new Date()}
        href="/x"
        onOpen={jest.fn()}
        onVote={jest.fn()}
      />,
    );
    expect(screen.getByTestId('feed-post-folded')).toHaveTextContent(
      'Asha’s scout found something. The note is in the talk.',
    );
  });
});

describe('the feed screen’s scout button', () => {
  it('is not there while scouts are off in this world, and nothing on the screen names scouts', async () => {
    await show(feed());
    expect(screen.queryByTestId('feed-scout-open')).not.toBeOnTheScreen();
    expect(screen.queryByText(/scouts/i)).not.toBeOnTheScreen();
  });

  it('offers to send one, then opens the sheet', async () => {
    await show(feed({ scout: none }));
    expect(screen.getByText('Send your scout')).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('feed-scout-open'));
    expect(screen.getByTestId('scout-sheet')).toBeOnTheScreen();
  });

  it('says “Your scout” once one is sent', async () => {
    await show(feed({ scout: on() }));
    expect(screen.getByText('Your scout')).toBeOnTheScreen();
  });

  it('lets a moderator stop a scout from its find', async () => {
    const stopScout = jest.fn(() => Promise.resolve(true));
    await show(feed({ posts: [post()], canEditMemory: true }), { stopScout });
    await fireEvent.press(screen.getByTestId('feed-post-stop-scout'));
    expect(stopScout).toHaveBeenCalledWith(asha.personId, true);
  });
});

describe('the Send your scout sheet', () => {
  const sheet = (scout: RoomScout, over: Partial<React.ComponentProps<typeof ScoutSheet>> = {}) =>
    wrap(
      <ScoutSheet
        scout={scout}
        working={false}
        refused={false}
        visible
        now={new Date('2026-11-04T10:00:00.000Z')}
        onSave={jest.fn(() => Promise.resolve(true))}
        onClose={jest.fn()}
        {...over}
      />,
    );

  it('says what it can read, that it signs with the member’s name, and that they are responsible', async () => {
    await sheet(none);
    expect(screen.getByText(/It\s+always signs with your name/)).toBeOnTheScreen();
    expect(screen.getByText(/Never your messages, your threads, your private rooms/)).toBeOnTheScreen();
    expect(screen.getByText(/You’re responsible for what it posts/)).toBeOnTheScreen();
    expect(screen.getByText(/Once a day per room is the most a scout can post/)).toBeOnTheScreen();
  });

  it('lists only the room’s topics, none ticked, and will not send until one is chosen', async () => {
    await sheet(none);
    for (const choice of choices) expect(screen.getByLabelText(choice.label)).toBeOnTheScreen();
    expect(screen.getByLabelText('Attention')).not.toBeChecked();
    expect(screen.getByTestId('scout-save')).toBeDisabled();
    expect(screen.queryByText('Pause my scout')).not.toBeOnTheScreen();
  });

  it('sends the member’s own choice, once they have made it', async () => {
    const onSave = jest.fn(() => Promise.resolve(true));
    await sheet(none, { onSave });
    await fireEvent.press(screen.getByLabelText('Training'));
    await fireEvent.press(screen.getByTestId('scout-cadence-weekly'));
    await fireEvent.press(screen.getByTestId('scout-save'));
    expect(onSave).toHaveBeenCalledWith({ interests: ['b'], cadence: 'weekly', paused: false });
  });

  it('allows five topics and no sixth', async () => {
    await sheet(none);
    for (const choice of choices.slice(0, 5)) await fireEvent.press(screen.getByLabelText(choice.label));
    expect(screen.getByLabelText('Scaling')).toBeDisabled();
    expect(screen.getByLabelText('Attention')).toBeChecked();
  });

  it('shows a scout that is sent as it stands, with a pause, a status and a way to take it back', async () => {
    const onSave = jest.fn(() => Promise.resolve(true));
    await sheet(on({ interests: ['b'], lastPostedAt: '2026-11-04T08:00:00.000Z' }), { onSave });
    expect(screen.getByLabelText('Training')).toBeChecked();
    expect(screen.getByTestId('scout-status')).toHaveTextContent('Looking. It last posted here 2 h ago.');
    await fireEvent.press(screen.getByLabelText('Pause my scout'));
    await fireEvent.press(screen.getByTestId('scout-save'));
    expect(onSave).toHaveBeenCalledWith({ interests: ['b'], cadence: 'daily', paused: true });
    await fireEvent.press(screen.getByTestId('scout-remove'));
    expect(onSave).toHaveBeenLastCalledWith(null);
  });

  it('tells the owner when a moderator stopped it', async () => {
    await sheet(on({ stopped: true }));
    expect(screen.getByTestId('scout-status')).toHaveTextContent(/A moderator stopped your scout/);
  });

  it('tells the owner their recording is paused, not that the scout is looking', async () => {
    await sheet(on({ recordingPaused: true }));
    expect(screen.getByTestId('scout-status')).toHaveTextContent(/Recording is paused, so your scout posts nothing/);
    expect(screen.getByTestId('scout-status')).not.toHaveTextContent(/Looking/);
  });

  it('says so when a change was refused', async () => {
    await sheet(none, { refused: true });
    expect(screen.getByText('Couldn’t change it.')).toBeOnTheScreen();
  });
});
