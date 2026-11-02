import type * as React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import type {
  AccountScope,
  RoomSkyController,
  RoomSkyState,
  RoomTodayController,
  RoomTodayState,
} from '@knowscroll/client-core';
import type { RoomDebate, RoomSky, RoomToday } from '@knowscroll/contracts';
import { DisplayProvider } from '@knowscroll/ui';
import { DebateCard } from './debate-card';
import { NowStrip } from './now-strip';
import { StartTopicSheet } from './start-topic-sheet';
import { TodayCards } from './today-cards';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ navigate: jest.fn(), push: mockPush, replace: jest.fn(), canGoBack: () => false }),
}));
const mockSky: { current: { controller: Partial<RoomSkyController>; state: Partial<RoomSkyState> } } = {
  current: { controller: {}, state: {} },
};
jest.mock('./use-room', () => ({ useRoomSky: () => mockSky.current }));

const id = (n: number) => `0199e000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
type Ready = Extract<RoomToday, { status: 'ready' }>;

const nova = { kind: 'ai' as const, inhabitant: 'explainer' as const, name: 'Nova', label: 'AI · Explainer' };
const halley = { kind: 'ai' as const, inhabitant: 'skeptic' as const, name: 'Halley', label: 'AI · Skeptic' };
const source = {
  status: 'available' as const,
  target: { assetId: id(40), assetRevision: 1 },
  metadata: {
    kind: 'scroll' as const,
    title: 'Why the Moon shows one face',
    summary: 'Tidal locking.',
    language: 'en',
  },
};
const today = (patch: Partial<Ready> = {}): Ready =>
  ({
    version: 'rooms.v1',
    readId: id(1),
    scope: { accountId: id(2), privacyEpoch: 1 },
    status: 'ready',
    day: '2026-10-27',
    discussionId: id(3),
    canPost: true,
    past: [],
    ...patch,
  }) as unknown as Ready;
const question = {
  ritualId: id(10),
  prompt: 'Why is the night sky dark?',
  detail: 'If the universe is full of stars, why is it not bright?',
  by: nova,
  source,
  messagesToday: 0,
};
const SENTENCES = [
  'The Moon always shows us the same face.',
  'That is because it turns once on its axis for every orbit.',
  'Its far side is a dark side that never gets sunlight.',
  'Earth’s pull locked it into that rhythm long ago.',
];
const openFlaw = { state: 'open' as const, ritualId: id(11), by: halley, sentences: SENTENCES };
const doneFlaw = (pick: number, correct: boolean, found = 3) => ({
  ...openFlaw,
  state: 'done' as const,
  yourPick: pick,
  correct,
  flawIndex: 2,
  original: 'Its far side gets as much sunlight as the side we see.',
  source,
  found,
});
const todayState = (patch: Partial<RoomTodayState> = {}): RoomTodayState => ({
  phase: 'ready',
  view: undefined,
  offline: false,
  working: false,
  refused: false,
  notSaved: undefined,
  starFor: undefined,
  ...patch,
});
const todayController = () =>
  ({ solve: jest.fn(() => Promise.resolve(true)), load: jest.fn() }) as unknown as RoomTodayController & {
    solve: jest.Mock;
  };
const wrap = (node: React.ReactNode) =>
  render(<DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>{node}</DisplayProvider>);

describe('Today: the day’s question', () => {
  it('asks it as a labelled resident, never drawn as a person, and offers Answer', async () => {
    const onAnswer = jest.fn();
    await wrap(
      <TodayCards view={today({ question })} state={todayState()} controller={todayController()} onAnswer={onAnswer} />,
    );
    expect(screen.getByText('Why is the night sky dark?')).toBeOnTheScreen();
    expect(screen.getByText('Nova')).toBeOnTheScreen();
    expect(screen.getByLabelText('AI, Explainer')).toBeOnTheScreen();
    // No messages yet: no number is invented.
    expect(screen.queryByTestId('today-messages')).not.toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('today-answer'));
    expect(onAnswer).toHaveBeenCalledTimes(1);
  });

  it('counts messages only when there are some, says what it counts, and links to the Scroll it cites', async () => {
    await wrap(
      <TodayCards
        view={today({ question: { ...question, messagesToday: 4 } })}
        state={todayState()}
        controller={todayController()}
        onAnswer={jest.fn()}
      />,
    );
    expect(screen.getByTestId('today-messages')).toHaveTextContent('4 messages in Today so far');
    await fireEvent.press(screen.getByRole('link', { name: 'Read the Scroll: Why the Moon shows one face' }));
    expect(mockPush).toHaveBeenCalledWith(`/scroll/${id(40)}`);
  });

  it('says plainly that nothing is ready when no item is approved for today, and lists past days', async () => {
    await wrap(
      <TodayCards
        view={today({ past: [{ day: '2026-10-26', prompt: 'Is Pluto a planet?' }] })}
        state={todayState()}
        controller={todayController()}
        onAnswer={jest.fn()}
      />,
    );
    expect(screen.getByText('Nothing for today yet')).toBeOnTheScreen();
    expect(screen.getByText('Is Pluto a planet?')).toBeOnTheScreen();
  });
});

describe('Today: Spot the flaw', () => {
  it('shows the sentences as buttons without the key, and a tap sends that sentence once', async () => {
    const controller = todayController();
    await wrap(
      <TodayCards view={today({ flaw: openFlaw })} state={todayState()} controller={controller} onAnswer={jest.fn()} />,
    );
    expect(screen.getByText('One sentence below is wrong. Tap it.')).toBeOnTheScreen();
    expect(screen.getByText('Halley')).toBeOnTheScreen();
    expect(screen.getByLabelText('AI, Skeptic')).toBeOnTheScreen();
    expect(screen.queryByText('ALTERED')).not.toBeOnTheScreen();
    expect(screen.queryByTestId('flaw-reveal')).not.toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('flaw-sentence-2'));
    expect(controller.solve).toHaveBeenCalledWith(id(11), 2);
  });

  it('after the tap, marks the altered sentence in words, shows the Scroll’s own, who found it, and the star', async () => {
    await wrap(
      <TodayCards
        view={today({ flaw: doneFlaw(2, true) })}
        state={todayState({ starFor: id(11) })}
        controller={todayController()}
        onAnswer={jest.fn()}
      />,
    );
    // The live region says the result once, in words, with which sentence was altered.
    expect(screen.getByText('Found it. Sentence 3 was altered.')).toBeOnTheScreen();
    expect(screen.getByTestId('flaw-status').props.accessibilityLiveRegion).toBe('polite');
    expect(screen.getByText('ALTERED')).toBeOnTheScreen();
    expect(
      screen.getByText('The Scroll says: Its far side gets as much sunlight as the side we see.'),
    ).toBeOnTheScreen();
    expect(screen.getByText('3 found it')).toBeOnTheScreen();
    expect(screen.getByTestId('flaw-star')).toHaveTextContent('+1 star for the room');
    // A finished item cannot be tapped again.
    expect(screen.getByTestId('flaw-sentence-0')).toBeDisabled();
  });

  it('says a wrong tap kindly and marks both the altered sentence and the reader’s own tap', async () => {
    await wrap(
      <TodayCards
        view={today({ flaw: doneFlaw(0, false, 1) })}
        state={todayState()}
        controller={todayController()}
        onAnswer={jest.fn()}
      />,
    );
    expect(screen.getByText('Not that one. Sentence 3 was altered; you tapped sentence 1.')).toBeOnTheScreen();
    expect(screen.getByText('ALTERED')).toBeOnTheScreen();
    expect(screen.getByText('YOUR TAP')).toBeOnTheScreen();
    // Each sentence says in its name what it is now, so a screen reader needs no colour or border.
    expect(screen.getByLabelText(`Sentence 3: ${SENTENCES[2]}, altered`)).toBeOnTheScreen();
    expect(screen.getByLabelText(`Sentence 1: ${SENTENCES[0]}, your tap`)).toBeOnTheScreen();
    expect(screen.getByLabelText(`Sentence 2: ${SENTENCES[1]}`)).toBeOnTheScreen();
    expect(screen.getByText('1 found it')).toBeOnTheScreen();
    expect(screen.queryByTestId('flaw-star')).not.toBeOnTheScreen();
  });

  it('keeps one polite live region mounted before the tap, so the result is announced when it comes', async () => {
    await wrap(
      <TodayCards
        view={today({ flaw: openFlaw })}
        state={todayState()}
        controller={todayController()}
        onAnswer={jest.fn()}
      />,
    );
    expect(screen.getByTestId('flaw-status').props.accessibilityLiveRegion).toBe('polite');
    expect(screen.getByTestId('flaw-status')).toHaveTextContent('One sentence below is wrong. Tap it.');
  });

  it('says plainly that a tap is not kept while recording is paused, and why', async () => {
    await wrap(
      <TodayCards
        view={today({ flaw: openFlaw })}
        state={todayState({ notSaved: 'recording_paused' })}
        controller={todayController()}
        onAnswer={jest.fn()}
      />,
    );
    expect(screen.getByTestId('flaw-paused')).toHaveTextContent(/Recording is paused\./);
    expect(screen.getByTestId('flaw-paused')).toHaveTextContent(/turn recording back on in Privacy/i);
  });

  it('tells a person whose tap did not arrive that it is not sent yet', async () => {
    await wrap(
      <TodayCards
        view={today({ flaw: openFlaw })}
        state={todayState({ offline: true })}
        controller={todayController()}
        onAnswer={jest.fn()}
      />,
    );
    expect(screen.getByText(/Not sent yet\./)).toBeOnTheScreen();
  });
});

describe('the Now strip and the room’s sky', () => {
  const sky = (patch: Partial<RoomSky> = {}): RoomSky => ({ lit: 3, of: 7, state: 'forming', finished: 0, ...patch });
  const scope = {} as AccountScope;
  const skyView = (patch: Record<string, unknown> = {}) => ({
    status: 'ready',
    sky: sky(),
    starsPerDay: 3,
    stars: [
      { act: 'daily_solved', day: '2026-10-27', constellation: 1 },
      { act: 'debate_closed', day: '2026-10-26', constellation: 1 },
      { act: 'answer_useful', day: '2026-10-25', constellation: 1 },
    ],
    ...patch,
  });

  it('shows Today with its question and the sky as "3 of 7", and never a number of people', async () => {
    await wrap(
      <NowStrip
        scope={scope}
        roomId={id(1)}
        today={{ discussionId: id(3), prompt: 'Why is the night sky dark?', flaw: true }}
        sky={sky()}
      />,
    );
    expect(screen.getByLabelText('Today, Why is the night sky dark?')).toBeOnTheScreen();
    expect(screen.getByLabelText('Room sky, 3 of 7 stars')).toBeOnTheScreen();
    expect(screen.queryByText(/online|here/i)).not.toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('now-today'));
    expect(mockPush).toHaveBeenCalledWith(`/rooms/${id(1)}/today`);
  });

  it('has no Today chip until an operator approved something, and still shows the sky', async () => {
    await wrap(<NowStrip scope={scope} roomId={id(1)} today={undefined} sky={sky({ lit: 0 })} />);
    expect(screen.queryByTestId('now-today')).not.toBeOnTheScreen();
    expect(screen.getByLabelText('Room sky, 0 of 7 stars')).toBeOnTheScreen();
  });

  it('opens the sky: lit stars are buttons that say which moment they were, the rest are only marks', async () => {
    mockSky.current = { controller: {}, state: { phase: 'ready', view: skyView() as never, working: false } };
    await wrap(<NowStrip scope={scope} roomId={id(1)} today={undefined} sky={sky()} />);
    await fireEvent.press(screen.getByTestId('now-sky'));
    expect(screen.getByTestId('sky-line')).toHaveTextContent('3 of 7 stars');
    expect(screen.getByRole('button', { name: 'Star 1 of 7' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Star 3 of 7' })).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Star 4 of 7' })).not.toBeOnTheScreen();
    expect(screen.getByTestId('sky-moment')).toHaveTextContent('Tap a star to see the moment that earned it.');
    await fireEvent.press(screen.getByRole('button', { name: 'Star 1 of 7' }));
    // Stars are shown oldest first: the first earned was an answer someone found useful, on 25 Oct.
    expect(screen.getByTestId('sky-moment')).toHaveTextContent('An answer marked useful · 25 Oct');
    expect(screen.getByText(/4 more stars light the station on its members’ maps/)).toBeOnTheScreen();
    // The cap is the server's number, not the screen's.
    expect(screen.getByText(/up to 3 a day/)).toBeOnTheScreen();
  });

  describe('how each star was earned, and flair (R3 E5)', () => {
    const asha = { kind: 'person' as const, personId: id(70), handle: 'ci.asha', displayName: 'Asha' };
    const moments = [
      { act: 'launch_finished', day: '2026-10-26', constellation: 1, played: 5 },
      { act: 'answer_useful', day: '2026-10-25', constellation: 1, by: asha, opens: { discussionId: id(80) } },
      {
        act: 'debate_closed',
        day: '2026-10-24',
        constellation: 1,
        title: 'Is Pluto a planet?',
        opens: { discussionId: id(81) },
      },
      { act: 'daily_solved', day: '2026-10-23', constellation: 1 },
      { act: 'answer_useful', day: '2026-10-22', constellation: 1 },
    ];
    const openSky = async (state: Partial<RoomSkyState>, controller: Partial<RoomSkyController> = {}) => {
      mockSky.current = {
        controller,
        state: {
          phase: 'ready',
          working: false,
          view: skyView({ sky: sky({ lit: 5 }), stars: moments }) as never,
          ...state,
        },
      };
      await wrap(
        <NowStrip scope={scope} roomId={id(1)} roomName="Space room" today={undefined} sky={sky({ lit: 5 })} />,
      );
      await fireEvent.press(screen.getByTestId('now-sky'));
    };
    const card = (patch: Record<string, unknown> = {}) =>
      ({
        status: 'ready',
        earned: ['first_answer', 'launch_regular'],
        // The server sends a partway count only for a mark made of the person's own acts (D-342), never Good question.
        coming: [{ flair: 'flaw_finder', have: 2, of: 3 }],
        shown: 'first_answer',
        ...patch,
      }) as never;

    it('lists each lit star’s moment below the art, newest first, in the words the server read for this reader', async () => {
      await openSky({});
      const lines = [
        'Launch, 26 Oct · 5 played',
        'Asha’s answer marked useful · 25 Oct',
        'Debate closed: Is Pluto a planet? · 24 Oct',
        'Spot the flaw found · 23 Oct',
        'An answer marked useful · 22 Oct',
      ];
      lines.forEach((words, index) =>
        expect(screen.getByTestId(`star-moment-${String(index)}`)).toHaveTextContent(words),
      );
      expect(screen.getByText('How each star was earned')).toBeOnTheScreen();
    });

    it('opens the discussion of a moment that has one, and leaves the others as words', async () => {
      await openSky({});
      expect(screen.queryByRole('link', { name: /Launch, 26 Oct/ })).not.toBeOnTheScreen();
      expect(screen.queryByRole('link', { name: /An answer marked useful · 22 Oct/ })).not.toBeOnTheScreen();
      await fireEvent.press(screen.getByRole('link', { name: 'Asha’s answer marked useful · 25 Oct, open it' }));
      expect(mockPush).toHaveBeenLastCalledWith(`/rooms/${id(1)}/t/${id(80)}`);
    });

    it('opens a debate’s discussion from its moment, and closes the sheet first', async () => {
      await openSky({});
      await fireEvent.press(screen.getByRole('link', { name: 'Debate closed: Is Pluto a planet? · 24 Oct, open it' }));
      expect(mockPush).toHaveBeenLastCalledWith(`/rooms/${id(1)}/t/${id(81)}`);
      expect(screen.queryByTestId('star-moments')).not.toBeOnTheScreen();
    });

    it('says the same words when a star is tapped in the art', async () => {
      await openSky({});
      await fireEvent.press(screen.getByRole('button', { name: 'Star 3 of 7' }));
      expect(screen.getByTestId('sky-moment')).toHaveTextContent('Debate closed: Is Pluto a planet? · 24 Oct');
    });

    it('draws the person’s own flair: the one showing, the ones earned and the one partway with how far', async () => {
      await openSky({ flair: card() });
      expect(screen.getByText('You in Space room')).toBeOnTheScreen();
      expect(screen.getByTestId('flair-shown')).toHaveTextContent('First answer · Showing');
      expect(screen.getByTestId('flair-earned-launch_regular')).toHaveTextContent('Launch regular');
      expect(screen.getByTestId('flair-coming-flaw_finder')).toHaveTextContent('Flaw finder · 2/3');
      expect(screen.queryByTestId('flair-coming-good_question')).not.toBeOnTheScreen();
      expect(screen.getByText('Only you see this card. Others see the one mark beside your name.')).toBeOnTheScreen();
      // No karma, no total, no ranking of people.
      expect(screen.queryByText(/karma|leaderboard|rank|level|points|total/i)).not.toBeOnTheScreen();
    });

    it('says how flair is earned when there is none yet, and offers no choice', async () => {
      await openSky({ flair: card({ earned: [], coming: [], shown: undefined }) });
      expect(screen.getByTestId('flair-empty')).toBeOnTheScreen();
      expect(screen.queryByTestId('flair-choose')).not.toBeOnTheScreen();
    });

    it('chooses what shows beside the name: a mark, the first earned, or nothing, as a radio group', async () => {
      const chooseFlair = jest.fn(() => Promise.resolve(true));
      await openSky({ flair: card() }, { chooseFlair });
      expect(screen.queryByTestId('flair-chooser')).not.toBeOnTheScreen();
      await fireEvent.press(screen.getByTestId('flair-choose'));
      expect(screen.getByRole('radio', { name: 'The first one I earned' })).toBeChecked();
      expect(screen.getByRole('radio', { name: 'First answer' })).not.toBeChecked();
      await fireEvent.press(screen.getByRole('radio', { name: 'Launch regular' }));
      expect(chooseFlair).toHaveBeenLastCalledWith('launch_regular');
      await fireEvent.press(screen.getByRole('radio', { name: 'Nothing' }));
      expect(chooseFlair).toHaveBeenLastCalledWith('none');
      await fireEvent.press(screen.getByRole('radio', { name: 'The first one I earned' }));
      expect(chooseFlair).toHaveBeenLastCalledWith('auto');
    });

    it('says it plainly when the flair is hidden, and checks the choice that was made', async () => {
      await openSky({ flair: card({ choice: 'none', shown: undefined }) });
      expect(screen.getByTestId('flair-hidden')).toBeOnTheScreen();
      expect(screen.queryByTestId('flair-shown')).not.toBeOnTheScreen();
      await fireEvent.press(screen.getByTestId('flair-choose'));
      expect(screen.getByRole('radio', { name: 'Nothing' })).toBeChecked();
    });

    it('still shows the sky when the flair card could not be read', async () => {
      await openSky({ flair: undefined });
      expect(screen.queryByTestId('flair-card')).not.toBeOnTheScreen();
      expect(screen.getByTestId('sky-line')).toHaveTextContent('5 of 7 stars');
    });
  });

  it('offers three names while a vote is open, chooses one, and shows counts only to a member who has voted', async () => {
    const name = jest.fn(() => Promise.resolve(true));
    const naming = {
      constellation: 1,
      candidates: ['The Lantern', 'The Kite', 'The Ferry'],
      closesAt: '2026-10-28T08:00:00.000Z',
    };
    mockSky.current = {
      controller: { name },
      state: {
        phase: 'ready',
        working: false,
        view: skyView({ sky: sky({ lit: 7, state: 'naming', finished: 1 }), naming }) as never,
      },
    };
    await wrap(
      <NowStrip scope={scope} roomId={id(1)} today={undefined} sky={sky({ lit: 7, state: 'naming', finished: 1 })} />,
    );
    await fireEvent.press(screen.getByTestId('now-sky'));
    expect(screen.getByText('Name this constellation')).toBeOnTheScreen();
    expect(screen.queryByText(/\d votes?$/)).not.toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('sky-name-1'));
    // The vote names the constellation the sheet showed (naming.constellation) and the name's place in its list.
    expect(name).toHaveBeenCalledWith(1, 1);
  });

  it('shows the counts once the member has voted, and the name once the room chose it', async () => {
    const naming = {
      constellation: 1,
      candidates: ['The Lantern', 'The Kite', 'The Ferry'],
      closesAt: '2026-10-28T08:00:00.000Z',
      yourVote: 1,
      votes: [1, 2, 0],
    };
    mockSky.current = {
      controller: {},
      state: {
        phase: 'ready',
        working: false,
        view: skyView({ sky: sky({ lit: 7, state: 'naming', finished: 1 }), naming }) as never,
      },
    };
    const first = await wrap(
      <NowStrip scope={scope} roomId={id(1)} today={undefined} sky={sky({ lit: 7, state: 'naming', finished: 1 })} />,
    );
    await fireEvent.press(screen.getByTestId('now-sky'));
    expect(screen.getByLabelText('The Kite, 2 votes')).toBeOnTheScreen();
    await first.unmount();
    const named = sky({ lit: 7, state: 'named', finished: 1, constellationName: 'The Kite' });
    mockSky.current = {
      controller: {},
      state: { phase: 'ready', working: false, view: skyView({ sky: named }) as never },
    };
    await wrap(<NowStrip scope={scope} roomId={id(1)} today={undefined} sky={named} />);
    await fireEvent.press(screen.getByTestId('now-sky'));
    expect(screen.getByText(/Seven stars, named The Kite/)).toBeOnTheScreen();
    expect(screen.queryByText('Name this constellation')).not.toBeOnTheScreen();
  });
});

describe('a debate', () => {
  const debate = (patch: Partial<RoomDebate> = {}): RoomDebate => ({
    sides: [{ text: 'Dark matter' }, { text: 'Modified gravity' }],
    closesAt: '2026-10-31T14:00:00.000Z',
    state: 'open',
    ...patch,
  });

  it('shows no count before the reader has voted, and a vote is one tap on a side', async () => {
    const onVote = jest.fn();
    await wrap(<DebateCard debate={debate()} canVote onVote={onVote} />);
    expect(screen.getByText('Choose a side to see how the room is voting.')).toBeOnTheScreen();
    expect(screen.queryByText(/\d votes?/)).not.toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('debate-side-b'));
    expect(onVote).toHaveBeenCalledWith('b');
  });

  it('shows the counts after a vote, lets the vote change, and says how many chose a side and never who', async () => {
    const onVote = jest.fn();
    await wrap(
      <DebateCard
        debate={debate({
          yourVote: 'a',
          sides: [
            { text: 'Dark matter', votes: 5 },
            { text: 'Modified gravity', votes: 2 },
          ],
        })}
        canVote
        onVote={onVote}
      />,
    );
    expect(screen.getByLabelText('Dark matter, 5 votes')).toBeOnTheScreen();
    expect(screen.getByLabelText('Modified gravity, 2 votes')).toBeOnTheScreen();
    expect(screen.getByText('Your vote is yours to change until it closes.')).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('debate-side-b'));
    expect(onVote).toHaveBeenCalledWith('b');
  });

  it('closes: names the winner, or says it closed level, and takes no more votes', async () => {
    const onVote = jest.fn();
    const closed = debate({
      state: 'closed',
      winner: 'a',
      sides: [
        { text: 'Dark matter', votes: 5 },
        { text: 'Modified gravity', votes: 2 },
      ],
    });
    const view = await wrap(<DebateCard debate={closed} canVote onVote={onVote} />);
    expect(screen.getByText('Dark matter won the vote.')).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('debate-side-b'));
    expect(onVote).not.toHaveBeenCalled();
    await view.unmount();
    const { winner: _none, ...level } = closed;
    await wrap(<DebateCard debate={level} canVote onVote={onVote} />);
    expect(screen.getByText('It closed level: no side won.')).toBeOnTheScreen();
  });

  it('says so, beside the result, when the last vote was not kept', async () => {
    const view = await wrap(<DebateCard debate={debate()} canVote refused onVote={jest.fn()} />);
    expect(screen.getByTestId('debate-refused')).toHaveTextContent(/Your vote wasn’t kept./);
    await view.unmount();
    await wrap(<DebateCard debate={debate()} canVote onVote={jest.fn()} />);
    expect(screen.queryByTestId('debate-refused')).not.toBeOnTheScreen();
  });

  it('cannot be voted on in a room that is paused', async () => {
    await wrap(<DebateCard debate={debate()} canVote={false} onVote={jest.fn()} />);
    expect(screen.getByTestId('debate-side-a')).toBeDisabled();
  });
});

describe('starting a debate', () => {
  const sheet = (patch: Partial<React.ComponentProps<typeof StartTopicSheet>> = {}) => {
    const onStart = jest.fn();
    return {
      onStart,
      shown: wrap(
        <StartTopicSheet
          visible
          suggestedTitle="Dark matter or modified gravity?"
          working={false}
          onClose={jest.fn()}
          onStart={onStart}
          {...patch}
        />,
      ),
    };
  };

  it('asks for two different sides and a time to close once the Debate tag is chosen, and sends them as one debate', async () => {
    const { onStart, shown } = sheet();
    await shown;
    expect(screen.queryByTestId('start-debate')).not.toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('start-topic-tag-debate'));
    expect(screen.getByTestId('start-debate')).toBeOnTheScreen();
    expect(screen.getByTestId('start-topic-submit')).toBeDisabled();
    await fireEvent.changeText(screen.getByTestId('start-debate-a'), 'Dark matter');
    await fireEvent.changeText(screen.getByTestId('start-debate-b'), 'dark matter');
    // The same side twice, whatever its case, is not a debate.
    expect(screen.getByTestId('start-topic-submit')).toBeDisabled();
    await fireEvent.changeText(screen.getByTestId('start-debate-b'), 'Modified gravity');
    await fireEvent.press(screen.getByTestId('start-debate-hours-72'));
    await fireEvent.press(screen.getByTestId('start-topic-submit'));
    expect(onStart).toHaveBeenCalledWith('Dark matter or modified gravity?', 'debate', {
      sides: ['Dark matter', 'Modified gravity'],
      closesInHours: 72,
    });
  });

  it('does not offer the Debate tag for a topic that begins with a message, which has no sides to give', async () => {
    const { shown } = sheet({ from: 'So dark matter exists' });
    await shown;
    expect(screen.queryByTestId('start-topic-tag-debate')).not.toBeOnTheScreen();
    expect(screen.getByTestId('start-topic-tag-question')).toBeOnTheScreen();
  });
});
