import type * as React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import type {
  AccountScope,
  RoomController,
  RoomReplayController,
  RoomReplayState,
  RoomState,
} from '@knowscroll/client-core';
import { LAUNCH_HOST, type ReplayRound, type RoomDiscussionSummary, type RoomView } from '@knowscroll/contracts';
import { DisplayProvider } from '@knowscroll/ui';
import { NowStrip } from './now-strip';
import { QuestionReplyCard, QuietOfferCard } from './quiet-cards';
import { QuestionsSheet } from './questions-sheet';
import { ReplaySheet } from './replay-sheet';
import { TopicCard } from './topic-card';

jest.mock('expo-router', () => ({
  useRouter: () => ({ navigate: jest.fn(), push: jest.fn(), replace: jest.fn(), canGoBack: () => false }),
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
// The countdown is drawn from the steady clock; a test fixes it so a number on screen is a number the state carried.
const mockNow = { current: 0 };
jest.mock('./use-launch', () => ({ useSteadyNow: () => mockNow.current, steadyClock: () => mockNow.current }));
const mockTopics: { current: readonly object[] | undefined } = { current: [] };
jest.mock('./use-room', () => ({
  useRoomSky: () => ({ controller: {}, state: { phase: 'loading', view: undefined, working: false } }),
  useRoomTopics: () => mockTopics.current,
}));

const id = (n: number) => `0199f100-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const person = (n: number, name: string) => ({
  kind: 'person' as const,
  personId: id(n),
  handle: `ci.${name.toLowerCase()}`,
  displayName: name,
});
const wrap = (node: React.ReactNode) =>
  render(<DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>{node}</DisplayProvider>);

beforeEach(() => {
  mockNow.current = 0;
  mockTopics.current = [];
});

// --- the replay ---------------------------------------------------------------------------------

type Answer = Extract<ReplayRound, { status: 'ready' }>;
const replay = {
  launchId: id(1),
  day: '2026-10-26',
  played: 5,
  questions: [1, 2, 3, 4, 5].map((round) => ({
    round,
    prompt: `Fixture question ${String(round)}?`,
    options: ['The Sun', 'Betelgeuse', 'About the same size'],
  })),
  answerSeconds: 8 as const,
};
const answerOf = (patch: Partial<Answer> = {}): Answer => ({
  status: 'ready',
  version: 'rooms.v1',
  readId: id(7),
  scope: { accountId: id(2), privacyEpoch: 1 },
  launchId: id(1),
  round: 2,
  correct: 1,
  explain: 'Betelgeuse is a red supergiant.',
  locked: 5,
  right: 3,
  calledIt: [{ person: person(12, 'Kenji'), you: false }],
  quicker: 1,
  ...patch,
});
const replayState = (patch: Partial<RoomReplayState> = {}): RoomReplayState => ({
  phase: 'ready',
  host: LAUNCH_HOST,
  replay,
  step: 'idle',
  index: 0,
  shownAt: 0,
  picked: undefined,
  answer: undefined,
  squares: [],
  working: false,
  offline: false,
  ...patch,
});
const replayController = () =>
  ({
    begin: jest.fn(),
    pick: jest.fn(() => Promise.resolve()),
    timeUp: jest.fn(() => Promise.resolve()),
    next: jest.fn(),
    leave: jest.fn(),
    load: jest.fn(),
  }) as unknown as RoomReplayController & Record<'begin' | 'pick' | 'timeUp' | 'next' | 'leave', jest.Mock>;

describe('the replay of a finished Launch', () => {
  const show = async (state: RoomReplayState, controller = replayController(), onClose = jest.fn()) => {
    await wrap(<ReplaySheet visible state={state} controller={controller} onClose={onClose} />);
    return { controller, onClose };
  };

  it.each([
    ['before it starts', replayState()],
    ['while a question is open', replayState({ step: 'asking', shownAt: 0 })],
    ['after an answer', replayState({ step: 'revealed', picked: 1, answer: answerOf(), squares: [true] })],
    ['at the end', replayState({ step: 'done', squares: [true, true, false, true, false] })],
  ] as const)(
    'says it is a replay, which night, how many played and that nothing is saved, %s',
    async (_when, state) => {
      await show(state);
      const banner = screen.getByTestId('replay-banner');
      expect(banner).toHaveTextContent(/^Replay./);
      expect(banner).toHaveTextContent(/26 Oct/);
      expect(banner).toHaveTextContent(/the 5 people who played/);
      expect(banner).toHaveTextContent(/nothing is saved/);
    },
  );

  it('has the host speak as a labelled AI in template words', async () => {
    await show(replayState());
    expect(screen.getByTestId('replay-host-name')).toHaveTextContent(/Pixel/);
    expect(screen.getByLabelText('AI, Quizmaster')).toBeOnTheScreen();
    expect(screen.getByTestId('replay-host-line')).toHaveTextContent(/Pixel here\. Five questions, 8 seconds each/);
  });

  it('starts from its first question on a tap and on nothing else', async () => {
    const { controller } = await show(replayState());
    expect(screen.queryByTestId('replay-question')).toBeNull();
    await fireEvent.press(screen.getByTestId('replay-start'));
    expect(controller.begin).toHaveBeenCalledTimes(1);
  });

  it('shows an open question with its options and no sign of which is right, and sends the tapped option', async () => {
    mockNow.current = 2_000;
    const { controller } = await show(replayState({ step: 'asking', index: 1, shownAt: 0 }));
    expect(screen.getByTestId('replay-round')).toHaveTextContent(/REPLAY 2 OF 5/);
    expect(screen.getByTestId('replay-prompt')).toHaveTextContent(/Fixture question 2?/);
    expect(screen.getByLabelText('6 seconds left')).toBeOnTheScreen();
    expect(screen.queryByTestId('replay-reveal')).toBeNull();
    expect(screen.queryByText(/Right answer/)).toBeNull();
    await fireEvent.press(screen.getByTestId('launch-option-1'));
    expect(controller.pick).toHaveBeenCalledWith(1);
  });

  it('shows the key when the time runs out on this device’s steady clock', async () => {
    mockNow.current = 8_000;
    const { controller } = await show(replayState({ step: 'asking', shownAt: 0 }));
    expect(controller.timeUp).toHaveBeenCalledTimes(1);
  });

  it('shows the key, the reason, who got it right and the place a right answer would have had, with nobody named as wrong', async () => {
    const { controller } = await show(
      replayState({ step: 'revealed', index: 1, picked: 1, answer: answerOf(), squares: [true, true] }),
    );
    expect(screen.getByLabelText('Option B: Betelgeuse, Right answer')).toBeOnTheScreen();
    expect(screen.getByTestId('replay-explain')).toHaveTextContent(/Betelgeuse is a red supergiant./);
    expect(screen.getByTestId('replay-called')).toHaveTextContent(/3 of 5 called it/);
    expect(screen.getByLabelText('Called it: Kenji')).toBeOnTheScreen();
    expect(screen.getByTestId('replay-verdict')).toHaveTextContent(/^Called it!/);
    expect(screen.getByTestId('replay-place')).toHaveTextContent(/You’d have been 2nd fastest./);
    await fireEvent.press(screen.getByTestId('replay-next'));
    expect(controller.next).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/wrong/i)).toBeNull();
  });

  it('calls a wrong answer a plot twist and a missed one time’s up, and gives neither a place', async () => {
    await show(replayState({ step: 'revealed', picked: 0, answer: answerOf(), squares: [false] }));
    expect(screen.getByTestId('replay-verdict')).toHaveTextContent(/^Plot twist/);
    expect(screen.queryByTestId('replay-place')).toBeNull();
  });

  it('says so when nobody answered a question, rather than inventing a crowd', async () => {
    await show(
      replayState({
        step: 'revealed',
        picked: undefined,
        answer: answerOf({ locked: 0, right: 0, calledIt: [], quicker: undefined }),
        squares: [false],
      }),
    );
    expect(screen.getByTestId('replay-called')).toHaveTextContent(/Nobody answered this one./);
    expect(screen.getByTestId('replay-verdict')).toHaveTextContent(/^Time’s up/);
    expect(screen.queryByTestId('replay-called-faces')).toBeNull();
  });

  it('offers the result after the last question, and the score at the end says nothing of anyone else', async () => {
    const view = replayState({
      step: 'revealed',
      index: 4,
      picked: 1,
      answer: answerOf({ round: 5 }),
      squares: [true, true, false, true, true],
    });
    const { controller } = await show(view);
    expect(screen.getByTestId('replay-next')).toHaveTextContent(/See how you did/);
    expect(screen.getByTestId('replay-round')).toHaveTextContent(/REPLAY 5 OF 5/);
    await fireEvent.press(screen.getByTestId('replay-leave'));
    expect(controller.leave).toHaveBeenCalledTimes(1);
  });

  it('ends with the score, the squares and a line that the podium and the star did not change', async () => {
    const { controller, onClose } = await show(
      replayState({ step: 'done', index: 4, squares: [true, true, false, true, false] }),
    );
    expect(screen.getByTestId('replay-done')).toHaveTextContent(/You’d have got 3 of 5 · ■■□■□/);
    expect(screen.getByTestId('replay-done')).toHaveTextContent(/The podium and the room’s star stay as they were./);
    await fireEvent.press(screen.getByTestId('replay-done-button'));
    expect(controller.leave).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['loading', /Looking for a Launch/],
    ['failed', /Couldn’t reach the room/],
    ['ready', /no Launch to replay right now/],
  ] as const)('says there is nothing to replay when it is %s', async (phase, words) => {
    await show(replayState({ replay: undefined, phase }));
    expect(screen.getByTestId('replay-none')).toHaveTextContent(words);
    expect(screen.queryByTestId('replay-start')).toBeNull();
  });

  it('says it is reconnecting when an answer did not get through', async () => {
    await show(replayState({ step: 'asking', offline: true }));
    expect(screen.getByText(/Reconnecting/)).toBeOnTheScreen();
  });
});

// --- the strip, the cards and the shelf ---------------------------------------------------------

describe('the Now strip in a quiet room', () => {
  const strip = (props: Partial<React.ComponentProps<typeof NowStrip>> = {}) =>
    wrap(
      <NowStrip
        scope={{} as AccountScope}
        roomId={id(1)}
        today={undefined}
        sky={{ lit: 3, of: 7, state: 'forming', finished: 0 }}
        {...props}
      />,
    );

  it('offers a replay by the night it is of, and only when there is one', async () => {
    const onReplay = jest.fn();
    await strip({ replay: { day: '2026-10-26' }, onReplay });
    expect(screen.getByTestId('now-replay')).toHaveTextContent(/Launch of 26 Oct/);
    await fireEvent.press(screen.getByTestId('now-replay'));
    expect(onReplay).toHaveBeenCalledTimes(1);
  });

  it('shows no replay chip and no question chip in a room that has neither and cannot be asked in', async () => {
    await strip({});
    expect(screen.queryByTestId('now-replay')).toBeNull();
    expect(screen.queryByTestId('now-questions')).toBeNull();
  });

  it('counts the questions that wait for a person, and otherwise offers to leave one', async () => {
    const onQuestions = jest.fn();
    await strip({ questions: { waiting: 3, replies: [] }, canAsk: true, onQuestions });
    expect(screen.getByTestId('now-questions')).toHaveTextContent(/^Open/);
    expect(screen.getByTestId('now-questions')).toHaveTextContent(/3 questions waiting/);
    await fireEvent.press(screen.getByTestId('now-questions'));
    expect(onQuestions).toHaveBeenCalledTimes(1);
  });

  it('says "Leave a question" and never a number when none waits', async () => {
    await strip({ questions: { waiting: 0, replies: [] }, canAsk: true });
    expect(screen.getByTestId('now-questions')).toHaveTextContent(/Leave a question/);
    expect(screen.getByTestId('now-questions')).not.toHaveTextContent(/\d/);
  });
});

describe('what the quiet room says on its own', () => {
  it('tells the asker who answered and how long it took, and lets them read it or put it away', async () => {
    const onRead = jest.fn();
    const onDismiss = jest.fn();
    await wrap(
      <QuestionReplyCard
        reply={{
          discussionId: id(3),
          title: 'How do astronomers know how far away a star is?',
          by: person(20, 'Lena'),
          askedAt: '2026-10-26T21:14:00.000Z',
          at: '2026-10-28T19:02:00.000Z',
        }}
        busy={false}
        onRead={onRead}
        onDismiss={onDismiss}
      />,
    );
    expect(screen.getByTestId('question-reply-line')).toHaveTextContent(/Lena answered your question · 1 day later/);
    expect(screen.getByText('How do astronomers know how far away a star is?')).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('question-reply-read'));
    await fireEvent.press(screen.getByTestId('question-reply-dismiss'));
    expect(onRead).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('offers the warm-up as the host, labelled AI, in words that name a real night and no people', async () => {
    const onReplay = jest.fn();
    const onDismiss = jest.fn();
    await wrap(
      <QuietOfferCard
        host={LAUNCH_HOST}
        line="It’s quiet here. Want a two-minute warm-up? The Launch of 26 Oct can be played again against the answers the people who played it gave."
        onReplay={onReplay}
        onDismiss={onDismiss}
      />,
    );
    expect(screen.getByLabelText('AI, Quizmaster')).toBeOnTheScreen();
    expect(screen.getByTestId('quiet-offer-line')).toHaveTextContent(/Launch of 26 Oct/);
    await fireEvent.press(screen.getByTestId('quiet-offer-replay'));
    await fireEvent.press(screen.getByTestId('quiet-offer-dismiss'));
    expect(onReplay).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe('a question card in General', () => {
  const summary = (patch: Partial<RoomDiscussionSummary> = {}): RoomDiscussionSummary => ({
    discussionId: id(3),
    kind: 'topic',
    title: 'How far away is a star?',
    tag: 'question',
    pinned: false,
    lastActivityAt: '2026-10-26T21:14:00.000Z',
    replyCount: 1,
    ...patch,
  });

  it('says a question is open for people while no person has answered, even when a resident did', async () => {
    await wrap(
      <TopicCard
        topic={{ discussionId: id(3), title: 'How far away is a star?', tag: 'question' }}
        figures={summary({ waiting: true, lastReplyBy: { name: 'Nova', ai: true } })}
        onOpen={jest.fn()}
      />,
    );
    expect(screen.getByText('Open for people')).toBeOnTheScreen();
    expect(screen.queryByText('Answered by a person')).toBeNull();
  });

  it('says a person answered it once one did', async () => {
    await wrap(
      <TopicCard
        topic={{ discussionId: id(3), title: 'How far away is a star?', tag: 'question' }}
        figures={summary()}
        onOpen={jest.fn()}
      />,
    );
    expect(screen.getByText('Answered by a person')).toBeOnTheScreen();
    expect(screen.queryByText('Open for people')).toBeNull();
  });

  it('says neither of a topic that is not a question', async () => {
    await wrap(
      <TopicCard
        topic={{ discussionId: id(4), title: 'Debate', tag: 'debate' }}
        figures={summary({ tag: 'debate' })}
        onOpen={jest.fn()}
      />,
    );
    expect(screen.queryByText('Open for people')).toBeNull();
    expect(screen.queryByText('Answered by a person')).toBeNull();
  });
});

// --- leaving a question -------------------------------------------------------------------------

type Member = Extract<RoomView, { status: 'member' }>;
const memberView = (patch: Partial<Member> = {}): Member => ({
  version: 'rooms.v1',
  readId: id(9),
  scope: { accountId: id(2), privacyEpoch: 1 },
  status: 'member',
  room: {
    roomId: id(1),
    name: 'Space room',
    description: 'Stars.',
    topic: { kind: 'system', id: 'astronomy', label: 'Astronomy' },
    joinRule: 'open',
    status: 'open',
  },
  role: 'member',
  hasModerator: false,
  inhabitants: [
    { inhabitant: 'explainer', name: 'Nova', label: 'AI · Explainer', blurb: 'Answers when asked' },
    { inhabitant: 'skeptic', name: 'Halley', label: 'AI · Skeptic', blurb: 'Pushes back on claims' },
  ],
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
  here: { faces: [{ person: person(10, 'Ravi'), you: true }] },
  memberTotal: 24,
  sky: { lit: 3, of: 7, state: 'forming', finished: 0 },
  limits: {
    asked: { perPersonPerHour: 10, perRoomPerDay: 80 },
    unprompted: { humanMessagesPerTurn: 3, perHour: 8, perDay: 40, explainerPerHour: 4, skepticPerHour: 3 },
  },
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
const roomController = (left: unknown = { discussionId: id(30), asked: 'queued' }) =>
  ({
    leaveQuestion: jest.fn(() => Promise.resolve(left)),
  }) as unknown as RoomController & { leaveQuestion: jest.Mock };

describe('leaving a question', () => {
  const sheet = async (view: Member, controller = roomController(), state = roomState(), onOpen = jest.fn()) => {
    await wrap(
      <QuestionsSheet
        scope={{} as AccountScope}
        view={view}
        controller={controller}
        state={state}
        visible
        onClose={jest.fn()}
        onOpen={onOpen}
      />,
    );
    return { controller, onOpen };
  };

  it('lists the questions that wait for a person and says honestly when none does', async () => {
    mockTopics.current = [
      {
        discussionId: id(30),
        kind: 'topic',
        title: 'How far away is a star?',
        tag: 'question',
        pinned: false,
        lastActivityAt: '2026-10-26T21:14:00.000Z',
        replyCount: 1,
        startedBy: person(20, 'Lena'),
        usefulCount: 0,
        answered: false,
        waiting: true,
      },
    ];
    const { onOpen } = await sheet(memberView({ questions: { waiting: 1, replies: [] } }));
    expect(screen.getByTestId('questions-count')).toHaveTextContent(/1 QUESTION WAITING/);
    expect(screen.getByText('Asked by Lena')).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId(`question-${id(30)}`));
    expect(onOpen).toHaveBeenCalledWith(id(30));
  });

  it('says no question is waiting when none is, and shows no number', async () => {
    await sheet(memberView());
    expect(screen.getByTestId('questions-count')).toHaveTextContent(/NO QUESTION IS WAITING/);
  });

  it('leaves a question with the choices made on it: a resident now and to be told, both on to begin with', async () => {
    const { controller } = await sheet(memberView());
    await fireEvent.press(screen.getByTestId('question-compose'));
    expect(screen.getByTestId('question-submit')).toBeDisabled();
    await fireEvent.changeText(screen.getByTestId('question-text'), 'How do astronomers know how far a star is?');
    expect(screen.getByRole('switch', { name: 'Ask Nova to answer now' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Tell me when a person answers' })).toBeChecked();
    await fireEvent.press(screen.getByTestId('question-submit'));
    expect(controller.leaveQuestion).toHaveBeenCalledWith({
      text: 'How do astronomers know how far a star is?',
      askNow: true,
      notify: true,
    });
    // It says that a resident is writing and that it will say it is AI.
    expect(await screen.findByTestId('question-left')).toHaveTextContent(/resident is writing.*AI/);
  });

  it('asks no resident when the asker switches it off, and tells nobody it was asked', async () => {
    const { controller } = await sheet(memberView(), roomController({ discussionId: id(31), asked: 'not_asked' }));
    await fireEvent.press(screen.getByTestId('question-compose'));
    await fireEvent.changeText(screen.getByTestId('question-text'), 'What is a light-year, exactly?');
    await fireEvent.press(screen.getByRole('switch', { name: 'Ask Nova to answer now' }));
    await fireEvent.press(screen.getByRole('switch', { name: 'Tell me when a person answers' }));
    await fireEvent.press(screen.getByTestId('question-submit'));
    expect(controller.leaveQuestion).toHaveBeenCalledWith({
      text: 'What is a light-year, exactly?',
      askNow: false,
      notify: false,
    });
    expect(await screen.findByTestId('question-left')).toHaveTextContent(/No resident was asked/);
  });

  it('never asks a resident for a member who keeps their messages out of what AI reads', async () => {
    const { controller } = await sheet(memberView({ you: { aiLevel: 'lively', keepOut: true } }));
    await fireEvent.press(screen.getByTestId('question-compose'));
    await fireEvent.changeText(screen.getByTestId('question-text'), 'What is a light-year, exactly?');
    expect(screen.getByRole('switch', { name: 'Ask Nova to answer now' })).not.toBeChecked();
    expect(screen.getByText(/keep your messages out of what AI reads/)).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('question-submit'));
    expect(controller.leaveQuestion).toHaveBeenCalledWith(expect.objectContaining({ askNow: false }));
  });

  it('opens the question that was left', async () => {
    const { onOpen } = await sheet(memberView(), roomController({ discussionId: id(32), asked: 'resting' }));
    await fireEvent.press(screen.getByTestId('question-compose'));
    await fireEvent.changeText(screen.getByTestId('question-text'), 'Why is the night sky dark?');
    await fireEvent.press(screen.getByTestId('question-submit'));
    expect(await screen.findByTestId('question-left')).toHaveTextContent(/The residents are resting/);
    await fireEvent.press(screen.getByTestId('question-open'));
    expect(onOpen).toHaveBeenCalledWith(id(32));
  });

  it('cannot be started in a room that does not take posts', async () => {
    await sheet(memberView({ canPost: false }));
    expect(screen.getByTestId('question-compose')).toBeDisabled();
  });
});
