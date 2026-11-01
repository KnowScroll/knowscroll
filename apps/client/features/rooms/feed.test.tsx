import type * as React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react-native';
import type { RoomFeedController, RoomFeedState } from '@knowscroll/client-core';
import type {
  ConversationContentProjection,
  RoomFeed,
  RoomFeedPost,
  RoomLiveEvent,
  RoomLaunchStrip,
} from '@knowscroll/contracts';
import { DisplayProvider } from '@knowscroll/ui';
import { RoomFeedScreen } from './feed-screen';
import { FeedPost } from './feed-post';
import { NowStrip } from './now-strip';
import { ResidentSheet } from './resident-sheet';

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
} as unknown as RoomFeed extends { identity: infer I } ? (I extends { kit: infer K } ? K : never) : never;
const identity = { kit };

const nova = { kind: 'ai' as const, inhabitant: 'explainer' as const, name: 'Nova', label: 'AI · Explainer' };
const halley = { kind: 'ai' as const, inhabitant: 'skeptic' as const, name: 'Halley', label: 'AI · Skeptic' };
const card = (kind: 'reel' | 'scroll' = 'reel'): ConversationContentProjection => ({
  status: 'available',
  target: { assetId: id(40), assetRevision: 1 },
  metadata: {
    kind,
    title: 'Light that bends around something we can’t see',
    summary: 'A cluster bends the light.',
    language: 'en',
  },
});
type Find = Extract<RoomFeedPost, { kind: 'find' }>;
const post = (patch: Partial<Find> = {}): Find => ({
  kind: 'find',
  discussionId: id(3),
  author: nova,
  postedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
  content: card(),
  note: 'Worth a look: at 0:40 the arc is the far galaxy, stretched by the cluster in front of it.',
  replies: 0,
  votes: 0,
  youVoted: false,
  canVote: true,
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
  residents: [
    { inhabitant: 'explainer', name: 'Nova', label: 'AI · Explainer', blurb: 'Answers when asked' },
    { inhabitant: 'skeptic', name: 'Halley', label: 'AI · Skeptic', blurb: 'Pushes back on claims' },
  ],
  memory: { state: 'none' },
  canEditMemory: false,
  aiLevel: 'lively',
  sort: 'hot',
  window: 'week',
  canPost: true,
  limits: { postsPerDay: 3, restHours: 6, memberPostsPerDay: 3 },
  ...patch,
});
const state = (patch: Partial<RoomFeedState> = {}): RoomFeedState => ({
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
  mockFeed.current = { controller, state: state({ view, ...patch }) };
  return wrap(<RoomFeedScreen roomId={roomId} />);
};

/** The words appear in the text content, whatever sits around them. */
const has = (text: string) => new RegExp(text.replaceAll(/[.*+?^${}()|[\]\\]/g, (character) => `\\${character}`));

beforeEach(() => mockPush.mockClear());

describe('a find in the feed', () => {
  it('shows the resident, labelled AI and named first, its note, the asset it is about and the way into the talk', async () => {
    await wrap(
      <FeedPost
        post={post()}
        identity={identity}
        now={new Date()}
        href="/rooms/x/t/y"
        onOpen={jest.fn()}
        onVote={jest.fn()}
      />,
    );
    expect(screen.getByText('Nova')).toBeOnTheScreen();
    // The AI label is read as "AI, Explainer"; the mark beside it is decoration and is hidden from a screen reader.
    expect(screen.getByLabelText('AI, Explainer')).toBeOnTheScreen();
    expect(screen.getByTestId('feed-post-mark', { includeHiddenElements: true }).props['aria-hidden']).toBe(true);
    expect(screen.getByTestId('feed-post-note')).toHaveTextContent(has('Worth a look: at 0:40'));
    expect(screen.getByText('2 h ago')).toBeOnTheScreen();
    expect(screen.getByText('Light that bends around something we can’t see')).toBeOnTheScreen();
    expect(screen.getByText('Open Reel')).toBeOnTheScreen();
    // The post is an article named for what it is, so a screen reader announces who posted and what it found before the details.
    const article = screen.getByTestId(`feed-post-${id(3)}`);
    expect(article.props.role).toBe('article');
    expect(article.props.accessibilityLabel).toMatch(/^Nova, AI, Explainer, found a Reel: Light that bends/);
  });

  it('has a vote for people, a count and no list of who, no karma and no way to message the resident', async () => {
    await wrap(
      <FeedPost
        post={post({ replies: 3, votes: 4 })}
        identity={identity}
        now={new Date()}
        href="/x"
        onOpen={jest.fn()}
        onVote={jest.fn()}
      />,
    );
    expect(screen.getByTestId('feed-vote')).toHaveProp('accessibilityLabel', '4 votes. Vote up');
    expect(screen.getByTestId('feed-vote-count')).toHaveTextContent('4');
    expect(screen.queryByText(/karma|leaderboard|rank|score|follow|message nova|dm|downvote/i)).not.toBeOnTheScreen();
    expect(screen.getByText('3 replies')).toBeOnTheScreen();
    expect(screen.queryByText(/online|here now/i)).not.toBeOnTheScreen();
  });

  it('votes with one tap', async () => {
    const onVote = jest.fn();
    await wrap(
      <FeedPost post={post()} identity={identity} now={new Date()} href="/x" onOpen={jest.fn()} onVote={onVote} />,
    );
    await fireEvent.press(screen.getByTestId('feed-vote'));
    expect(onVote).toHaveBeenLastCalledWith(true);
  });

  it('takes the vote back with a second tap, and the label says which it will do', async () => {
    const onVote = jest.fn();
    await wrap(
      <FeedPost
        post={post({ votes: 1, youVoted: true })}
        identity={identity}
        now={new Date()}
        href="/x"
        onOpen={jest.fn()}
        onVote={onVote}
      />,
    );
    expect(screen.getByTestId('feed-vote')).toHaveProp('accessibilityLabel', '1 vote. You voted. Take your vote back');
    await fireEvent.press(screen.getByTestId('feed-vote'));
    expect(onVote).toHaveBeenLastCalledWith(false);
  });

  it('holds the note back for a Quieter reader, says where it is and opens that talk from the button beside it', async () => {
    const onOpen = jest.fn();
    const { note: _note, ...quiet } = post();
    await wrap(
      <FeedPost
        post={{ ...quiet, folded: true }}
        identity={identity}
        now={new Date()}
        href="/x"
        onOpen={onOpen}
        onVote={jest.fn()}
      />,
    );
    expect(screen.getByTestId('feed-post-discuss')).toHaveTextContent('Read the note');
    await fireEvent.press(screen.getByTestId('feed-post-discuss'));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('feed-post-note')).not.toBeOnTheScreen();
    expect(screen.getByTestId('feed-post-folded')).toHaveTextContent(
      has('Nova found something. The note is in the talk.'),
    );
  });

  it('says plainly that a find’s asset is gone, and still opens the talk', async () => {
    const onOpen = jest.fn();
    await wrap(
      <FeedPost
        post={post({ content: { status: 'unavailable', target: { assetId: id(40), assetRevision: 1 } }, replies: 1 })}
        identity={identity}
        now={new Date()}
        href="/rooms/x/t/y"
        onOpen={onOpen}
        onVote={jest.fn()}
      />,
    );
    expect(screen.getByText('This content is no longer available.')).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('feed-post-discuss'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('draws a Skeptic’s find with its own name and label', async () => {
    await wrap(
      <FeedPost
        post={post({ author: halley })}
        identity={identity}
        now={new Date()}
        href="/x"
        onOpen={jest.fn()}
        onVote={jest.fn()}
      />,
    );
    expect(screen.getByText('Halley')).toBeOnTheScreen();
    expect(screen.getByLabelText('AI, Skeptic')).toBeOnTheScreen();
  });
});

describe('the Feed screen', () => {
  it('lists the finds newest first, each a link into its talk', async () => {
    const view = feed({
      posts: [post({ discussionId: id(3) }), post({ discussionId: id(4), author: halley, content: card('scroll') })],
    });
    await show(view);
    expect(screen.getByTestId('feed-list').props.role).toBe('list');
    expect(screen.getAllByTestId(/^feed-post-[0-9a-f-]{36}$/)).toHaveLength(2);
    await fireEvent.press(screen.getAllByTestId('feed-post-discuss')[1]!);
    expect(mockPush).toHaveBeenCalledWith(`/rooms/${roomId}/t/${id(4)}`);
  });

  it('says honestly that nothing is new when the library has nothing for the room, and invents nothing', async () => {
    await show(feed());
    expect(screen.getByTestId('feed-empty')).toHaveTextContent(has('Nothing new right now'));
    expect(screen.getByTestId('feed-empty')).toHaveTextContent(has('They say nothing when it has not.'));
    expect(screen.queryByTestId('feed-list')).not.toBeOnTheScreen();
  });

  it('tells a reader whose residents are off why the feed is empty', async () => {
    await show(feed({ aiLevel: 'off' }));
    expect(screen.getByTestId('feed-empty')).toHaveTextContent(has('Residents are off for you'));
  });

  it('lists the residents as labelled chips and opens a profile from one', async () => {
    await show(
      feed({ memory: { state: 'ready', text: 'People compared tides.\nOne question is open.', by: 'residents' } }),
    );
    expect(screen.getByRole('button', { name: /Nova, AI, Explainer\. Open profile/ })).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('feed-resident-skeptic'));
    expect(screen.getByTestId('resident-sheet')).toBeOnTheScreen();
    expect(screen.getByTestId('resident-memory-text')).toHaveTextContent(has('People compared tides.'));
    expect(screen.getByTestId('resident-rhythm')).toHaveTextContent(has('Looks at the room about 3 times a day'));
    expect(screen.getByTestId('resident-rhythm')).toHaveTextContent(has('Each posts at most once every 6 hours'));
  });

  it('is told, when the server refuses, that the room is not available, without why', async () => {
    mockFeed.current = { controller: {}, state: state({ phase: 'unavailable', view: undefined }) };
    await wrap(<RoomFeedScreen roomId={roomId} />);
    expect(screen.getByText('The feed isn’t available')).toBeOnTheScreen();
  });
});

describe('a resident’s profile', () => {
  const open = (
    view: Extract<RoomFeed, { status: 'ready' }>,
    patch: { onReplace?: jest.Mock; working?: boolean; refused?: boolean } = {},
  ) =>
    wrap(
      <ResidentSheet
        resident={view.residents[0]}
        feed={view}
        identity={identity}
        working={patch.working ?? false}
        refused={patch.refused ?? false}
        visible
        onClose={jest.fn()}
        onReplace={patch.onReplace ?? jest.fn(() => Promise.resolve(true))}
      />,
    );

  it('says there is nothing remembered yet, and who wrote it when there is', async () => {
    await open(feed());
    expect(screen.getByTestId('resident-memory-text')).toHaveTextContent(has('Nothing yet.'));
    expect(screen.queryByTestId('memory-editor')).not.toBeOnTheScreen();
  });

  it('says that a moderator wrote it when one did', async () => {
    await open(feed({ memory: { state: 'ready', text: 'Beginners are welcome.', by: 'moderator' } }));
    expect(screen.getByTestId('resident-memory')).toHaveTextContent(has('A moderator wrote this.'));
  });

  it('offers a moderator the editor, saves their words and can clear them', async () => {
    const onReplace = jest.fn(() => Promise.resolve(true));
    await open(feed({ canEditMemory: true }), { onReplace });
    await fireEvent.changeText(screen.getByTestId('memory-input'), '  Please be kind to beginners.  ');
    await fireEvent.press(screen.getByTestId('memory-save'));
    expect(onReplace).toHaveBeenLastCalledWith('Please be kind to beginners.');
    await fireEvent.press(screen.getByTestId('memory-clear'));
    expect(onReplace).toHaveBeenLastCalledWith(null);
  });

  it('cannot save nothing, and says plainly when the room refused', async () => {
    await open(feed({ canEditMemory: true }), { refused: true });
    expect(screen.getByTestId('memory-save')).toBeDisabled();
    expect(screen.getByText('Couldn’t change it.')).toBeOnTheScreen();
  });
});

describe('the live strip on the Now strip', () => {
  const event = (patch: Partial<RoomLiveEvent> = {}): RoomLiveEvent => ({
    kind: 'posted',
    by: nova,
    at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    discussionId: id(3),
    ...patch,
  });
  const sky = { lit: 2, of: 7 as const, state: 'forming' as const, finished: 0 };
  const noLaunch: RoomLaunchStrip | undefined = undefined;

  it('shows who posted and who replied and how long ago, each opening its post, and a Feed chip that opens the feed', async () => {
    const asha = { kind: 'person' as const, personId: id(7), handle: 'asha', displayName: 'Asha' };
    await wrap(
      <NowStrip
        scope={{} as never}
        roomId={roomId}
        today={undefined}
        sky={sky}
        launch={noLaunch}
        live={[
          event({
            kind: 'replied',
            by: { kind: 'person', person: asha, you: false },
            at: new Date(Date.now() - 20 * 60_000).toISOString(),
            discussionId: id(4),
          }),
          event(),
        ]}
      />,
    );
    expect(screen.getByTestId('now-feed')).toHaveTextContent(has('Ashareplied · 20 min ago'));
    expect(screen.getByTestId('now-feed')).toHaveProp('accessibilityLabel', 'Feed, Asha replied · 20 min ago');
    expect(screen.getByTestId('now-feed-1')).toHaveTextContent(has('Novaposted · 2 h ago'));
    await fireEvent.press(screen.getByTestId('now-feed'));
    expect(mockPush).toHaveBeenCalledWith(`/rooms/${roomId}/t/${id(4)}`);
    await fireEvent.press(screen.getByTestId('now-feed-open'));
    expect(mockPush).toHaveBeenCalledWith(`/rooms/${roomId}/feed`);
    expect(screen.queryByText(/online|people here|\d+ (people|members)/i)).not.toBeOnTheScreen();
  });

  it('draws the agent ring on a resident’s or scout’s chip and reads it as an AI, and draws none on a person’s', async () => {
    const asha = { kind: 'person' as const, personId: id(7), handle: 'asha', displayName: 'Asha' };
    const scout = { kind: 'agent' as const, sentBy: asha, label: 'AI · Scout' as const };
    await wrap(
      <NowStrip
        scope={{} as never}
        roomId={roomId}
        today={undefined}
        sky={sky}
        launch={noLaunch}
        live={[
          event({ kind: 'replied', by: { kind: 'person', person: asha, you: false }, discussionId: id(4) }),
          event({ discussionId: id(5) }),
          event({ by: scout, discussionId: id(6) }),
        ]}
      />,
    );
    expect(within(screen.getByTestId('now-feed')).queryByTestId('orbit-ring')).not.toBeOnTheScreen();
    expect(screen.getByTestId('now-feed')).toHaveProp('accessibilityLabel', 'Feed, Asha replied · 2 h ago');
    expect(within(screen.getByTestId('now-feed-1')).getByTestId('orbit-ring')).toBeOnTheScreen();
    expect(screen.getByTestId('now-feed-1')).toHaveProp(
      'accessibilityLabel',
      'Feed, AI resident Nova posted · 2 h ago',
    );
    expect(within(screen.getByTestId('now-feed-2')).getByTestId('orbit-ring')).toBeOnTheScreen();
    expect(screen.getByTestId('now-feed-2')).toHaveProp(
      'accessibilityLabel',
      'Feed, AI scout, sent by Asha, posted · 2 h ago',
    );
  });

  it('shows no event when nothing happened, and still the way into the Feed', async () => {
    await wrap(<NowStrip scope={{} as never} roomId={roomId} today={undefined} sky={sky} live={undefined} />);
    expect(screen.queryByTestId('now-feed')).not.toBeOnTheScreen();
    expect(screen.getByTestId('now-feed-open')).toBeOnTheScreen();
  });
});
