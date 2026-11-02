import type * as React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import type { PostOutcome, RoomFeedController, RoomFeedState } from '@knowscroll/client-core';
import type { ConversationContentProjection, RoomFeed, RoomFeedPost } from '@knowscroll/contracts';
import { DisplayProvider } from '@knowscroll/ui';
import { RoomFeedPanel } from './feed-screen';
import { FeedPost } from './feed-post';
import { PostSheet } from './post-sheet';

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
const mockKept: { current: unknown } = { current: { status: 'ready', items: [] } };
jest.mock('./use-kept', () => ({ useKept: () => mockKept.current }));
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
const asha = { kind: 'person' as const, personId: id(7), handle: 'asha', displayName: 'Asha' };
const nova = { kind: 'ai' as const, inhabitant: 'explainer' as const, name: 'Nova', label: 'AI · Explainer' };

const card: ConversationContentProjection = {
  status: 'available',
  target: { assetId: id(40), assetRevision: 1 },
  metadata: { kind: 'reel', title: 'Light that bends', summary: 'A cluster bends the light.', language: 'en' },
};
type MemberPost = Extract<RoomFeedPost, { kind: 'post' }>;
const memberPost = (patch: Partial<MemberPost> = {}): MemberPost => ({
  kind: 'post',
  discussionId: id(5),
  author: { kind: 'person', person: asha, you: false },
  postedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
  title: 'Found a Reel on gravitational lensing',
  words: 'At 0:40 the arc is a normal galaxy far behind, stretched by mass we mostly cannot see.',
  link: { kind: 'content', content: card },
  replies: 0,
  votes: 14,
  youVoted: false,
  canVote: true,
  ...patch,
});
const sourcePost = (patch: Partial<MemberPost> = {}): MemberPost =>
  memberPost({
    discussionId: id(6),
    title: 'A paper on lensing',
    link: { kind: 'source', source: { url: 'https://www.nature.com/articles/s41586', host: 'nature.com' } },
    ...patch,
  });
const resident: RoomFeedPost = {
  kind: 'find',
  discussionId: id(3),
  author: nova,
  postedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
  content: card,
  note: 'Worth a look: the arc is the far galaxy.',
  replies: 0,
  votes: 3,
  youVoted: false,
  canVote: true,
};
const feed = (patch: Partial<Extract<RoomFeed, { status: 'ready' }>> = {}): Extract<RoomFeed, { status: 'ready' }> => ({
  version: 'rooms.v1',
  readId: id(2),
  scope: { accountId: id(9), privacyEpoch: 1 },
  status: 'ready',
  roomId,
  roomName: 'Space room',
  profiles: [],
  identity,
  sort: 'hot',
  window: 'week',
  posts: [],
  canPost: true,
  residents: [{ inhabitant: 'explainer', name: 'Nova', label: 'AI · Explainer', blurb: 'Answers when asked' }],
  memory: { state: 'none' },
  canEditMemory: false,
  aiLevel: 'lively',
  limits: { postsPerDay: 3, restHours: 6, memberPostsPerDay: 3 },
  ...patch,
});
const stateOf = (patch: Partial<RoomFeedState> = {}): RoomFeedState => ({
  phase: 'ready',
  view: undefined,
  sort: 'hot',
  window: 'week',
  offline: false,
  working: false,
  refused: false,
  ...patch,
});
const wrap = (node: React.ReactNode) =>
  render(<DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>{node}</DisplayProvider>);
const show = (
  view: Extract<RoomFeed, { status: 'ready' }>,
  controller: Partial<RoomFeedController> = {},
  patch: Partial<RoomFeedState> = {},
) => {
  mockFeed.current = { controller, state: stateOf({ view, ...patch }) };
  return wrap(<RoomFeedPanel scope={{ active: true } as never} roomId={roomId} />);
};
const has = (text: string) => new RegExp(text.replaceAll(/[.*+?^${}()|[\]\\]/g, (character) => `\\${character}`));

beforeEach(() => {
  mockPush.mockClear();
  mockKept.current = { status: 'ready', items: [] };
});

describe('a member’s post in the feed (v3 R-8b)', () => {
  const draw = (post: RoomFeedPost, onVote = jest.fn()) =>
    wrap(<FeedPost post={post} identity={identity} now={new Date()} href="/x" onOpen={jest.fn()} onVote={onVote} />);

  it('shows the member, their headline and words, the asset it links and a vote with a count', async () => {
    await draw(memberPost());
    expect(screen.getByText('Asha')).toBeOnTheScreen();
    expect(screen.getByTestId('feed-post-title')).toHaveTextContent('Found a Reel on gravitational lensing');
    expect(screen.getByTestId('feed-post-note')).toHaveTextContent(has('At 0:40 the arc is a normal galaxy'));
    expect(screen.getByText('Light that bends')).toBeOnTheScreen();
    expect(screen.getByText('12 min ago')).toBeOnTheScreen();
    expect(screen.getByTestId('feed-vote-count')).toHaveTextContent('14');
    // A person is never drawn with the AI label or the ring.
    expect(screen.queryByLabelText(/^AI,/)).not.toBeOnTheScreen();
    expect(screen.queryByTestId('feed-post-mark', { includeHiddenElements: true })).not.toBeOnTheScreen();
    const article = screen.getByTestId(`feed-post-${id(5)}`);
    expect(article.props.accessibilityLabel).toBe('Asha posted a Reel: Found a Reel on gravitational lensing');
  });

  it('draws a source as a plain link: the site, the whole address, opening in a new tab, never a preview', async () => {
    await draw(sourcePost());
    const link = screen.getByTestId('feed-post-source');
    expect(link.props.role).toBe('link');
    expect(link.props.accessibilityLabel).toBe(
      'Source: nature.com. Opens https://www.nature.com/articles/s41586 in a new tab',
    );
    expect(screen.getByText('nature.com')).toBeOnTheScreen();
    expect(screen.getByText('https://www.nature.com/articles/s41586')).toBeOnTheScreen();
    expect(screen.queryByText('Open Reel')).not.toBeOnTheScreen();
    expect(screen.getByTestId(`feed-post-${id(6)}`).props.accessibilityLabel).toBe(
      'Asha posted a Link: A paper on lensing',
    );
  });

  it('shows the reader’s own post with the count and no way to vote on it', async () => {
    await draw(memberPost({ author: { kind: 'person', person: asha, you: true }, canVote: false, votes: 2 }));
    expect(screen.getByText('You')).toBeOnTheScreen();
    expect(screen.getByTestId('feed-vote')).toHaveProp('accessibilityLabel', '2 votes. Your own post');
    expect(screen.getByTestId('feed-vote').props.onClick).toBeUndefined();
    expect(screen.queryByRole('button', { name: /Vote up/ })).not.toBeOnTheScreen();
  });

  it('votes and takes the vote back with the post’s own control', async () => {
    const onVote = jest.fn();
    await draw(memberPost({ votes: 1, youVoted: true }), onVote);
    await fireEvent.press(screen.getByRole('button', { name: /You voted/ }));
    expect(onVote).toHaveBeenCalledWith(false);
  });
});

describe('the Feed screen with people’s posts (v3 R-8b)', () => {
  it('mixes people’s posts and residents’ finds, and says votes come from people only', async () => {
    await show(feed({ posts: [memberPost(), resident] }));
    expect(screen.getAllByTestId(/^feed-post-[0-9a-f-]{36}$/)).toHaveLength(2);
    expect(screen.getByTestId('feed-people-only')).toHaveTextContent('VOTES COME FROM PEOPLE ONLY · AGENTS CAN’T VOTE');
    // The resident wears its label and mark; the person does not.
    expect(screen.getAllByLabelText('AI, Explainer').length).toBeGreaterThan(0);
    expect(screen.queryByText(/karma|leaderboard|rising/i)).not.toBeOnTheScreen();
  });

  it('offers Hot, New and Top, marks the one in use, and asks the controller to change it', async () => {
    const setSort = jest.fn(() => Promise.resolve());
    await show(feed(), { setSort });
    expect(screen.getByTestId('feed-sort-hot')).toBeOnTheScreen();
    expect(screen.getByTestId('feed-sort-new')).toBeOnTheScreen();
    expect(screen.getByTestId('feed-sort-top')).toBeOnTheScreen();
    expect(screen.queryByTestId('feed-sort-rising')).not.toBeOnTheScreen();
    expect(screen.getByTestId('feed-sort-hot')).toHaveProp(
      'accessibilityState',
      expect.objectContaining({ checked: true }),
    );
    expect(screen.getByTestId('feed-sort-new')).toHaveProp(
      'accessibilityState',
      expect.objectContaining({ checked: false }),
    );
    await fireEvent.press(screen.getByTestId('feed-sort-new'));
    expect(setSort).toHaveBeenCalledWith('new');
  });

  it('offers the window only under Top, and asks the controller to change it', async () => {
    const setWindow = jest.fn(() => Promise.resolve());
    await show(feed({ sort: 'top' }), { setWindow }, { sort: 'top' });
    for (const window of ['day', 'week', 'month', 'all'])
      expect(screen.getByTestId(`feed-window-${window}`)).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('feed-window-month'));
    expect(setWindow).toHaveBeenCalledWith('month');
  });

  it('has no window under Hot or New', async () => {
    await show(feed());
    expect(screen.queryByTestId('feed-window-week')).not.toBeOnTheScreen();
  });

  it('votes through the controller, and opens the talk of a post', async () => {
    const vote = jest.fn(() => Promise.resolve(true));
    await show(feed({ posts: [memberPost()] }), { vote });
    await fireEvent.press(screen.getByTestId('feed-vote'));
    expect(vote).toHaveBeenCalledWith(id(5), true);
    await fireEvent.press(screen.getByTestId('feed-post-discuss'));
    expect(mockPush).toHaveBeenCalledWith(`/rooms/${roomId}/t/${id(5)}`);
  });

  it('offers Post only to a member who may post now, and a reader whose AI is off still sees members’ posts', async () => {
    await show(feed({ canPost: false, aiLevel: 'off', posts: [memberPost()] }));
    expect(screen.queryByTestId('feed-post-open')).not.toBeOnTheScreen();
    expect(screen.getByTestId('feed-list')).toBeOnTheScreen();
    expect(screen.queryByTestId('feed-empty')).not.toBeOnTheScreen();
  });

  it('opens the post sheet from Post', async () => {
    await show(feed());
    await fireEvent.press(screen.getByTestId('feed-post-open'));
    expect(screen.getByTestId('post-sheet')).toBeOnTheScreen();
  });
});

describe('the post sheet (v3 R-8b)', () => {
  const open = (onPost: (draft: unknown) => Promise<PostOutcome>, onClose = jest.fn(), onOpenExisting = jest.fn()) =>
    wrap(
      <PostSheet
        scope={{} as never}
        visible
        working={false}
        postsPerDay={3}
        onPost={onPost}
        onOpenExisting={onOpenExisting}
        onClose={onClose}
      />,
    );

  it('cannot post without a headline, words and a link, and says the words are the member’s own', async () => {
    await open(jest.fn());
    expect(screen.getByTestId('post-send')).toBeDisabled();
    expect(screen.getByText(/no AI writes or changes them/)).toBeOnTheScreen();
    expect(screen.getByText(/You can post 3 a day in this room/)).toBeOnTheScreen();
  });

  it('posts a source link, trimmed, and closes when it was posted', async () => {
    const onPost = jest.fn(() => Promise.resolve({ kind: 'posted', discussionId: id(50) } as PostOutcome));
    const onClose = jest.fn();
    await open(onPost, onClose);
    await fireEvent.changeText(screen.getByTestId('post-title'), 'A paper on lensing');
    await fireEvent.changeText(screen.getByTestId('post-words'), 'The arc is a far galaxy.');
    await fireEvent.press(screen.getByTestId('post-mode-source'));
    await fireEvent.changeText(screen.getByTestId('post-source'), 'https://example.org/lensing');
    expect(screen.getByTestId('post-send')).toBeEnabled();
    await fireEvent.press(screen.getByTestId('post-send'));
    expect(onPost).toHaveBeenCalledWith({
      title: 'A paper on lensing',
      words: 'The arc is a far galaxy.',
      link: { kind: 'source', url: 'https://example.org/lensing' },
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('refuses to enable Post for a link in the words or an address that is not http or https', async () => {
    await open(jest.fn());
    await fireEvent.changeText(screen.getByTestId('post-title'), 'Headline');
    await fireEvent.changeText(screen.getByTestId('post-words'), 'See https://example.com for it');
    await fireEvent.press(screen.getByTestId('post-mode-source'));
    await fireEvent.changeText(screen.getByTestId('post-source'), 'https://example.org/a');
    expect(screen.getByTestId('post-send')).toBeDisabled();
    await fireEvent.changeText(screen.getByTestId('post-words'), 'Words only.');
    await fireEvent.changeText(screen.getByTestId('post-source'), 'ftp://example.org/a');
    expect(screen.getByTestId('post-send')).toBeDisabled();
  });

  it('posts something the member kept, chosen from their own Keep list', async () => {
    mockKept.current = {
      status: 'ready',
      items: [
        {
          assetId: id(40),
          assetRevision: 1,
          kind: 'reel',
          availability: 'available',
          metadata: { title: 'Light that bends' },
        },
      ],
    };
    const onPost = jest.fn(() => Promise.resolve({ kind: 'posted', discussionId: id(50) } as PostOutcome));
    await open(onPost);
    await fireEvent.changeText(screen.getByTestId('post-title'), 'Headline');
    await fireEvent.changeText(screen.getByTestId('post-words'), 'Words.');
    expect(screen.getByTestId('post-send')).toBeDisabled();
    await fireEvent.press(screen.getByText('Light that bends'));
    await fireEvent.press(screen.getByTestId('post-send'));
    expect(onPost).toHaveBeenCalledWith(
      expect.objectContaining({ link: { kind: 'content', target: { assetId: id(40), assetRevision: 1 } } }),
    );
  });

  it('says when the room already has the post and opens it, and says when the day’s posts are used or the link is refused', async () => {
    const outcomes: PostOutcome[] = [
      { kind: 'already_there', discussionId: id(60) },
      { kind: 'rate_limited' },
      { kind: 'refused' },
    ];
    const onPost = jest.fn(() => Promise.resolve(outcomes.shift() as PostOutcome));
    const onOpenExisting = jest.fn();
    await open(onPost, jest.fn(), onOpenExisting);
    await fireEvent.changeText(screen.getByTestId('post-title'), 'Headline');
    await fireEvent.changeText(screen.getByTestId('post-words'), 'Words.');
    await fireEvent.press(screen.getByTestId('post-mode-source'));
    await fireEvent.changeText(screen.getByTestId('post-source'), 'https://example.org/a');
    await fireEvent.press(screen.getByTestId('post-send'));
    expect(screen.getByTestId('post-existing')).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('post-existing-open'));
    expect(onOpenExisting).toHaveBeenCalledWith(id(60));
    await fireEvent.press(screen.getByTestId('post-send'));
    expect(screen.getByText(/posted as much as one room takes in a day/)).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('post-send'));
    expect(screen.getByText(/could not be posted/)).toBeOnTheScreen();
  });
});
