import type * as React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import type { RoomFeedController, RoomFeedState } from '@knowscroll/client-core';
import type { RoomFeed, RoomFeedPost, RoomFeedStrip, RoomLaunchStrip } from '@knowscroll/contracts';
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
    state: { phase: 'loading', view: undefined, offline: false, working: false, refused: false },
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
const card = (kind: 'reel' | 'scroll' = 'reel'): RoomFeedPost['content'] => ({
  status: 'available',
  target: { assetId: id(40), assetRevision: 1 },
  metadata: {
    kind,
    title: 'Light that bends around something we can’t see',
    summary: 'A cluster bends the light.',
    language: 'en',
  },
});
const post = (patch: Partial<RoomFeedPost> = {}): RoomFeedPost => ({
  discussionId: id(3),
  author: nova,
  postedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
  content: card(),
  note: 'Worth a look: at 0:40 the arc is the far galaxy, stretched by the cluster in front of it.',
  replies: 0,
  ...patch,
});
const feed = (patch: Partial<Extract<RoomFeed, { status: 'ready' }>> = {}): Extract<RoomFeed, { status: 'ready' }> => ({
  version: 'rooms.v1',
  readId: id(2),
  scope: { accountId: id(9), privacyEpoch: 1 },
  status: 'ready',
  roomId,
  identity,
  posts: [],
  residents: [
    { inhabitant: 'explainer', name: 'Nova', label: 'AI · Explainer', blurb: 'Answers when asked' },
    { inhabitant: 'skeptic', name: 'Halley', label: 'AI · Skeptic', blurb: 'Pushes back on claims' },
  ],
  memory: { state: 'none' },
  canEditMemory: false,
  aiLevel: 'lively',
  limits: { postsPerDay: 3, restHours: 6 },
  ...patch,
});
const state = (patch: Partial<RoomFeedState> = {}): RoomFeedState => ({
  phase: 'ready',
  view: undefined,
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
    await wrap(<FeedPost post={post()} identity={identity} now={new Date()} href="/rooms/x/t/y" onOpen={jest.fn()} />);
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

  it('has nothing to vote with, no count of people and no way to message the resident', async () => {
    await wrap(
      <FeedPost post={post({ replies: 3 })} identity={identity} now={new Date()} href="/x" onOpen={jest.fn()} />,
    );
    expect(screen.queryByText(/vote|upvote|like|follow|message nova|dm/i)).not.toBeOnTheScreen();
    expect(screen.getByText('3 replies')).toBeOnTheScreen();
    expect(screen.queryByText(/online|here now|\bpeople\b/i)).not.toBeOnTheScreen();
  });

  it('holds the note back for a Quieter reader, says where it is and opens that talk from the button beside it', async () => {
    const onOpen = jest.fn();
    const { note: _note, ...quiet } = post();
    await wrap(
      <FeedPost post={{ ...quiet, folded: true }} identity={identity} now={new Date()} href="/x" onOpen={onOpen} />,
    );
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
      />,
    );
    expect(screen.getByText('This content is no longer available.')).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('feed-post-discuss'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('draws a Skeptic’s find with its own name and label', async () => {
    await wrap(
      <FeedPost post={post({ author: halley })} identity={identity} now={new Date()} href="/x" onOpen={jest.fn()} />,
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

describe('the Feed on the Now strip', () => {
  const strip = (patch: Partial<RoomFeedStrip> = {}): RoomFeedStrip => ({
    by: nova,
    postedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    ...patch,
  });
  const sky = { lit: 2, of: 7 as const, state: 'forming' as const, finished: 0 };
  const noLaunch: RoomLaunchStrip | undefined = undefined;

  it('shows who found something and how long ago, and opens the feed', async () => {
    await wrap(
      <NowStrip scope={{} as never} roomId={roomId} today={undefined} sky={sky} launch={noLaunch} feed={strip()} />,
    );
    expect(screen.getByTestId('now-feed')).toHaveTextContent(has('Nova found something · 2 h ago'));
    await fireEvent.press(screen.getByTestId('now-feed'));
    expect(mockPush).toHaveBeenCalledWith(`/rooms/${roomId}/feed`);
  });

  it('shows nothing of the feed when no find is there for this reader', async () => {
    await wrap(<NowStrip scope={{} as never} roomId={roomId} today={undefined} sky={sky} feed={undefined} />);
    expect(screen.queryByTestId('now-feed')).not.toBeOnTheScreen();
  });
});
