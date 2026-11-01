import type * as React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { timeOfDayWords, type RoomFeedController, type RoomFeedState } from '@knowscroll/client-core';
import type { RoomFeed, RoomFeedPost, RoomResidentProfile } from '@knowscroll/contracts';
import { DisplayProvider } from '@knowscroll/ui';
import { AiLabel } from './ai-label';
import { FeedPost } from './feed-post';
import { RoomFeedScreen } from './feed-screen';
import { PostBar } from './post-bar';
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
const mockReported = jest.fn();
jest.mock('../feedback/feedback-sheet', () => ({
  FeedbackSheet: ({ target }: { target: unknown }) => {
    mockReported(target);
    return null;
  },
}));

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
const nova = { kind: 'ai' as const, inhabitant: 'explainer' as const, name: 'Nova', label: 'AI · Explainer' };
type Intro = Extract<RoomFeedPost, { kind: 'intro' }>;
const intro = (patch: Partial<Intro> = {}): Intro => ({
  kind: 'intro',
  discussionId: id(9),
  author: nova,
  postedAt: new Date(Date.now() - 3_600_000).toISOString(),
  text: "Hi, I'm Nova. I explain things by finding Reels and Scrolls in the library that this room has not seen.",
  replies: 2,
  votes: 6,
  youVoted: false,
  canVote: true,
  ...patch,
});
const profile = (patch: Partial<RoomResidentProfile> = {}): RoomResidentProfile => ({
  inhabitant: 'explainer',
  madeBy: 'KnowScroll',
  caresAbout: ['Plain explanations', 'Finds from the library'],
  roomSince: '2026-10-02T10:00:00.000Z',
  lastAt: '2026-11-01T21:12:00.000Z',
  nextAfter: '2026-11-02T03:12:00.000Z',
  introduced: false,
  recent: [
    {
      discussionId: id(30),
      messageId: id(31),
      title: 'Light that bends around something',
      postedAt: '2026-11-01T21:12:00.000Z',
    },
  ],
  ...patch,
});
const feed = (patch: Partial<Extract<RoomFeed, { status: 'ready' }>> = {}): Extract<RoomFeed, { status: 'ready' }> => ({
  version: 'rooms.v1',
  readId: id(2),
  scope: { accountId: id(9), privacyEpoch: 1 },
  status: 'ready',
  roomId,
  roomName: 'Space room',
  profiles: [profile()],
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
const wrap = (node: React.ReactNode) =>
  render(<DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>{node}</DisplayProvider>);
const show = (view: Extract<RoomFeed, { status: 'ready' }>, controller: Partial<RoomFeedController> = {}) => {
  mockFeed.current = {
    controller,
    state: { phase: 'ready', view, sort: 'hot', window: 'week', offline: false, working: false, refused: false },
  };
  return wrap(<RoomFeedScreen roomId={roomId} />);
};
const has = (text: string) => new RegExp(text.replaceAll(/[.*+?^${}()|[\]\\]/g, (character) => `\\${character}`));

beforeEach(() => {
  mockPush.mockClear();
  mockReported.mockClear();
});

describe('the ring (v3 R-8b, D-279)', () => {
  it('is on every AI label, has a name of its own for a screen reader, and sits before the label that says which agent', async () => {
    await wrap(<AiLabel label="AI · Explainer" />);
    const ring = screen.getByTestId('orbit-ring');
    expect(ring.props.role).toBe('img');
    expect(ring.props.accessibilityLabel).toBe('Agent ring');
    expect(screen.getByLabelText('AI, Explainer')).toBeOnTheScreen();
  });

  it('is on a scout’s label too', async () => {
    await wrap(<AiLabel label="AI · Scout" />);
    expect(screen.getByTestId('orbit-ring')).toBeOnTheScreen();
  });

  it('is never on a member’s own post: a person is not an agent', async () => {
    const asha = { kind: 'person' as const, personId: id(7), handle: 'asha', displayName: 'Asha' };
    await wrap(
      <FeedPost
        post={{
          kind: 'post',
          discussionId: id(5),
          author: { kind: 'person', person: asha, you: false },
          postedAt: new Date().toISOString(),
          title: 'A headline',
          words: 'Some words.',
          link: { kind: 'source', source: { url: 'https://example.org/a', host: 'example.org' } },
          replies: 0,
          votes: 0,
          youVoted: false,
          canVote: true,
        }}
        identity={identity}
        now={new Date()}
        href="/x"
        onOpen={jest.fn()}
        onVote={jest.fn()}
      />,
    );
    expect(screen.queryByTestId('orbit-ring')).not.toBeOnTheScreen();
  });
});

describe('a resident’s introduction in the feed', () => {
  it('says who it is in the product’s words, that the mods introduced it once, and carries the ring, with no vote and no talk', async () => {
    const onVote = jest.fn();
    await wrap(
      <FeedPost post={intro()} identity={identity} now={new Date()} href="/x" onOpen={jest.fn()} onVote={onVote} />,
    );
    expect(screen.getByText('A NEW RESIDENT')).toBeOnTheScreen();
    expect(screen.getByTestId('feed-post-note')).toHaveTextContent(has("Hi, I'm Nova."));
    expect(screen.getByTestId('feed-post-introduced')).toHaveTextContent(
      'Introduced by the room’s mods · one introduction, no follow-up hellos',
    );
    expect(screen.getByTestId('orbit-ring')).toBeOnTheScreen();
    expect(screen.getByLabelText('AI, Explainer')).toBeOnTheScreen();
    expect(screen.getByTestId('feed-post-' + id(9)).props.accessibilityLabel).toBe('Nova, AI, Explainer, introduction');
    expect(screen.queryByTestId('feed-vote')).not.toBeOnTheScreen();
    expect(screen.queryByTestId('feed-post-discuss')).not.toBeOnTheScreen();
    expect(screen.queryByText(/replies|Start the talk/)).not.toBeOnTheScreen();
    expect(onVote).not.toHaveBeenCalled();
  });
});

describe('a resident’s profile (v3 R-8b, D-277)', () => {
  const open = (
    view: Extract<RoomFeed, { status: 'ready' }>,
    handlers: { onMute?: jest.Mock; onReport?: jest.Mock; onIntroduce?: jest.Mock; onOpenPost?: jest.Mock } = {},
  ) =>
    wrap(
      <ResidentSheet
        resident={view.residents[0]}
        feed={view}
        identity={identity}
        working={false}
        refused={false}
        visible
        onClose={jest.fn()}
        onReplace={jest.fn(() => Promise.resolve(true))}
        {...handlers}
      />,
    );

  it('says who made it, where it lives, what it cares about, and when it last spoke and may post next', async () => {
    // The last time it spoke is said as how long ago, in the same words as the rest of the room; the clock is the device's.
    const clock = jest.spyOn(Date, 'now').mockReturnValue(new Date('2026-11-02T02:15:00.000Z').getTime());
    await open(feed());
    expect(screen.getByTestId('resident-made-by')).toHaveTextContent('AGENT · MADE BY KNOWSCROLL');
    expect(screen.getByTestId('resident-since')).toHaveTextContent('Lives in Space room since 2 Oct');
    expect(screen.getByTestId('resident-interests')).toHaveTextContent(has('Plain explanations'));
    expect(screen.getByTestId('resident-last')).toHaveTextContent('LAST 5 h ago');
    expect(screen.getByTestId('resident-next')).toHaveTextContent(
      `NEXT AFTER ${timeOfDayWords('2026-11-02T03:12:00.000Z')}`,
    );
    expect(screen.getByTestId('orbit-ring')).toBeOnTheScreen();
    expect(screen.getByText('The ring next to a name means agent. It can’t be removed or hidden.')).toBeOnTheScreen();
    clock.mockRestore();
  });

  it('says nothing of a last or next time a resident has not got', async () => {
    await open(feed({ profiles: [profile({ lastAt: undefined, nextAfter: undefined, recent: [] })] }));
    expect(screen.queryByTestId('resident-last')).not.toBeOnTheScreen();
    expect(screen.queryByTestId('resident-next')).not.toBeOnTheScreen();
    expect(screen.queryByTestId('resident-recent')).not.toBeOnTheScreen();
    expect(screen.queryByTestId('resident-report')).not.toBeOnTheScreen();
  });

  it('mutes the room’s residents, and says it is the one switch for them all', async () => {
    const onMute = jest.fn();
    await open(feed(), { onMute });
    expect(screen.getByTestId('resident-mute')).toHaveTextContent('Mute residents here');
    expect(screen.getByTestId('resident-mute')).toHaveProp(
      'accessibilityHint',
      expect.stringContaining('residents and scouts'),
    );
    await fireEvent.press(screen.getByTestId('resident-mute'));
    expect(onMute).toHaveBeenLastCalledWith(true);
  });

  it('lets the residents speak again when they were muted', async () => {
    const onMute = jest.fn();
    await open(feed({ aiLevel: 'off' }), { onMute });
    expect(screen.getByTestId('resident-mute')).toHaveTextContent('Unmute residents here');
    await fireEvent.press(screen.getByTestId('resident-mute'));
    expect(onMute).toHaveBeenLastCalledWith(false);
  });

  it('for a reader whose AI is Off shows no last or next time, no recent post and no Report, and keeps the profile, Mute and Introduce', async () => {
    const onReport = jest.fn();
    const onMute = jest.fn();
    const onIntroduce = jest.fn();
    await open(
      feed({
        aiLevel: 'off',
        canEditMemory: true,
        profiles: [profile({ lastAt: undefined, nextAfter: undefined, recent: [] })],
      }),
      { onReport, onMute, onIntroduce },
    );
    expect(screen.getByTestId('resident-made-by')).toBeOnTheScreen();
    expect(screen.getByTestId('resident-interests')).toBeOnTheScreen();
    expect(screen.queryByTestId('resident-last')).not.toBeOnTheScreen();
    expect(screen.queryByTestId('resident-next')).not.toBeOnTheScreen();
    expect(screen.queryByTestId('resident-recent')).not.toBeOnTheScreen();
    expect(screen.queryByTestId('resident-report')).not.toBeOnTheScreen();
    expect(screen.getByTestId('resident-mute')).toHaveTextContent('Unmute residents here');
    expect(screen.getByTestId('resident-introduce-button')).toBeOnTheScreen();
  });

  it('reports the resident’s newest post, and opens a recent one', async () => {
    const onReport = jest.fn();
    const onOpenPost = jest.fn();
    await open(feed(), { onReport, onOpenPost });
    await fireEvent.press(screen.getByTestId('resident-report'));
    expect(onReport).toHaveBeenCalledWith(id(31));
    await fireEvent.press(screen.getByTestId(`resident-recent-${id(30)}`));
    expect(onOpenPost).toHaveBeenCalledWith(id(30));
  });

  it('offers a moderator an introduction that has not been made, and nobody else', async () => {
    const onIntroduce = jest.fn();
    await open(feed({ canEditMemory: true }), { onIntroduce });
    await fireEvent.press(screen.getByTestId('resident-introduce-button'));
    expect(onIntroduce).toHaveBeenCalledWith('explainer');
  });

  it('offers a member who is not a moderator no introduction', async () => {
    await open(feed(), { onIntroduce: jest.fn() });
    expect(screen.queryByTestId('resident-introduce')).not.toBeOnTheScreen();
  });

  it('offers no introduction that was already made', async () => {
    await open(feed({ canEditMemory: true, profiles: [profile({ introduced: true })] }), { onIntroduce: jest.fn() });
    expect(screen.queryByTestId('resident-introduce')).not.toBeOnTheScreen();
  });
});

describe('the feed screen’s profile', () => {
  it('opens from a resident, mutes through the controller and reports the newest post', async () => {
    const setMuted = jest.fn(() => Promise.resolve(true));
    await show(feed(), { setMuted });
    await fireEvent.press(screen.getByTestId('feed-resident-explainer'));
    await fireEvent.press(screen.getByTestId('resident-mute'));
    expect(setMuted).toHaveBeenCalledWith(true);
    await fireEvent.press(screen.getByTestId('resident-report'));
    expect(mockReported).toHaveBeenLastCalledWith({ kind: 'room_message', messageId: id(31) });
  });
});

describe('a post’s own page (D-273)', () => {
  it('shows the vote and a source as a plain link, and votes through the page', async () => {
    const onVote = jest.fn();
    await wrap(
      <PostBar
        discussionId={id(5)}
        post={{ votes: 3, youVoted: false, canVote: true }}
        source={{ url: 'https://example.org/a', host: 'example.org' }}
        onVote={onVote}
      />,
    );
    expect(screen.getByTestId('feed-post-source')).toHaveProp(
      'accessibilityLabel',
      'Source: example.org. Opens https://example.org/a in a new tab',
    );
    expect(screen.getByTestId('feed-vote')).toHaveProp('accessibilityLabel', '3 votes. Vote up');
    await fireEvent.press(screen.getByTestId('feed-vote'));
    expect(onVote).toHaveBeenCalledWith(true);
  });

  it('has no vote to give on one’s own post, and no source for a post that cites an asset', async () => {
    await wrap(
      <PostBar
        discussionId={id(5)}
        post={{ votes: 1, youVoted: false, canVote: false }}
        source={undefined}
        onVote={jest.fn()}
      />,
    );
    expect(screen.queryByTestId('feed-post-source')).not.toBeOnTheScreen();
    expect(screen.getByTestId('feed-vote')).toHaveProp('accessibilityLabel', '1 vote. Your own post');
  });
});
