import { fireEvent, render, screen } from '@testing-library/react-native';
import type { InhabitantStatus, RoomDiscussionController, RoomDiscussionState } from '@knowscroll/client-core';
import type { RoomAway, RoomDiscussionSummary, RoomMessage } from '@knowscroll/contracts';
import { DisplayProvider } from '@knowscroll/ui';
import { AiHere } from './ai-here';
import { AiNoticeCard } from './ai-notice';
import { askedLine, topicTitleFrom } from './ask-words';
import { AwayCard } from './away-card';
import { MessageOptionsSheet } from './message-options-sheet';
import { RoomMessages } from './room-messages';
import { StartTopicSheet } from './start-topic-sheet';
import { topicFigures } from './topic-card';

const id = (n: number) => `0199c000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const asha = { kind: 'person' as const, personId: id(10), handle: 'ci.asha', displayName: 'Asha' };
const ravi = { kind: 'person' as const, personId: id(11), handle: 'ci.ravi', displayName: 'Ravi' };
const at = '2026-10-24T08:00:00.000Z';
const wrap = (node: React.ReactNode) =>
  render(<DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>{node}</DisplayProvider>);

const text = (sequence: number, author: typeof asha, value: string): RoomMessage => ({
  messageId: id(100 + sequence),
  sequence,
  status: 'available',
  author,
  recordedAt: at,
  body: { kind: 'text', text: value },
});
const halley: RoomMessage = {
  messageId: id(200),
  sequence: 3,
  status: 'available',
  author: { kind: 'ai', inhabitant: 'skeptic', name: 'Halley', label: 'AI · Skeptic' },
  recordedAt: at,
  body: { kind: 'text', text: 'That holds for lensing. One gap: primordial black holes.' },
  suggestion: 'assumption',
  ask: { kind: 'challenge', by: asha, about: id(101) },
};
const inhabitants = (ask: InhabitantStatus['ask'] = 'available'): InhabitantStatus[] => [
  { inhabitant: 'explainer', name: 'Nova', label: 'AI · Explainer', blurb: 'Answers when asked', ask },
  { inhabitant: 'skeptic', name: 'Halley', label: 'AI · Skeptic', blurb: 'Pushes back on claims', ask },
];

describe('what an ask is called', () => {
  it('says who asked and what, and "you" for the reader', () => {
    expect(askedLine({ kind: 'challenge', by: asha }, ravi.personId)).toBe('Asked by Asha · Challenge');
    expect(askedLine({ kind: 'other_side', by: asha }, asha.personId)).toBe('Asked by you · The other side');
    expect(askedLine({ kind: 'mention', by: asha }, undefined)).toBe('Asked by Asha · Named in a message');
  });

  it('leaves the asker out when the reader has blocked them or their account is gone', () => {
    expect(askedLine({ kind: 'about' }, asha.personId)).toBe('Asked about a message');
  });
});

describe('a topic’s title from the words it began with', () => {
  it('collapses whitespace and cuts a long message with an ellipsis, as the server does', () => {
    expect(topicTitleFrom('  So the Moon\n alone   explains the tides?  ')).toBe(
      'So the Moon alone explains the tides?',
    );
    const long = topicTitleFrom('word '.repeat(40));
    expect([...long]).toHaveLength(80);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('a topic’s figures', () => {
  it('says how many replies and who spoke last, and that no one has replied yet', () => {
    expect(topicFigures({ replyCount: 0 })).toBe('No replies yet');
    expect(topicFigures({ replyCount: 1 })).toBe('1 reply');
    expect(topicFigures({ replyCount: 8, lastReplyBy: { name: 'Halley', ai: true } })).toBe('8 replies · last: Halley');
  });
});

describe('a resident’s answer to an ask, and the cards a topic leaves', () => {
  const state = (messages: RoomMessage[]): RoomDiscussionState => ({
    phase: 'ready',
    view: undefined,
    messages,
    outgoing: [],
    hasOlder: false,
    loadingOlder: false,
    offline: false,
    asking: false,
  });
  const show = async (messages: RoomMessage[], extra: Partial<React.ComponentProps<typeof RoomMessages>> = {}) => {
    const onAskAbout = jest.fn();
    const onOpenTopic = jest.fn();
    await wrap(
      <RoomMessages
        state={state(messages)}
        controller={{} as RoomDiscussionController}
        role="member"
        ownPersonId={ravi.personId}
        episodes={[]}
        series={false}
        scrollRef={{ current: null }}
        onScroll={() => undefined}
        onOpenSnippet={() => undefined}
        onStartThread={() => undefined}
        onActions={() => undefined}
        canAsk
        onAskAbout={onAskAbout}
        onOpenTopic={onOpenTopic}
        {...extra}
      />,
    );
    return { onAskAbout, onOpenTopic };
  };

  it('names the asker and the kind above the answer, and offers to challenge it or hear the other side', async () => {
    const { onAskAbout } = await show([text(1, asha, 'Lensing says it is spread out'), halley]);
    expect(screen.getByTestId('resident-asked')).toHaveTextContent(/Asked by Asha · Challenge/);
    await fireEvent.press(screen.getByTestId(`challenge-${halley.messageId}`));
    expect(onAskAbout).toHaveBeenCalledWith('challenge', halley.messageId);
    await fireEvent.press(screen.getByTestId(`other-side-${halley.messageId}`));
    expect(onAskAbout).toHaveBeenCalledWith('other_side', halley.messageId);
  });

  it('turns the buttons off when no resident can be asked now', async () => {
    const { onAskAbout } = await show([halley], { canAsk: false });
    await fireEvent.press(screen.getByTestId(`challenge-${halley.messageId}`));
    expect(onAskAbout).not.toHaveBeenCalled();
  });

  it('draws the card a topic left with its figures from the room, and opens the topic', async () => {
    const card: RoomMessage = {
      messageId: id(300),
      sequence: 4,
      status: 'available',
      author: asha,
      recordedAt: at,
      body: {
        kind: 'topic',
        topic: { discussionId: id(400), title: 'Dark matter or modified gravity?', tag: 'debate' },
      },
    };
    const figures: RoomDiscussionSummary = {
      discussionId: id(400),
      kind: 'topic',
      title: 'Dark matter or modified gravity?',
      tag: 'debate',
      pinned: false,
      lastActivityAt: at,
      replyCount: 8,
      lastReplyBy: { name: 'Halley', ai: true },
    };
    const { onOpenTopic } = await show([card], { topics: new Map([[figures.discussionId, figures]]) });
    const topic = screen.getByTestId(`topic-card-${id(400)}`);
    expect(topic).toHaveTextContent(/Dark matter or modified gravity\?/);
    expect(topic).toHaveTextContent(/Debate/);
    expect(topic).toHaveTextContent(/8 replies · last: Halley/);
    await fireEvent.press(topic);
    expect(onOpenTopic).toHaveBeenCalledWith(id(400));
  });

  it('draws the card without figures when the room has not said any, and says to the maker that they marked a message useful', async () => {
    const card: RoomMessage = {
      messageId: id(300),
      sequence: 4,
      status: 'available',
      author: asha,
      recordedAt: at,
      body: { kind: 'topic', topic: { discussionId: id(400), title: 'A topic' } },
    };
    await show([card, { ...text(5, asha, 'useful words'), usefulByYou: true as const } as RoomMessage]);
    expect(screen.getByTestId(`topic-card-${id(400)}`)).not.toHaveTextContent('replies');
    expect(screen.getByText('You marked this useful')).toBeOnTheScreen();
  });
});

describe('the message menu', () => {
  const open = (message: RoomMessage, patch: Partial<React.ComponentProps<typeof MessageOptionsSheet>> = {}) => {
    const handlers = {
      onClose: jest.fn(),
      onStartThread: jest.fn(),
      onStartTopic: jest.fn(),
      onAsk: jest.fn(),
      onUseful: jest.fn(),
      onHide: jest.fn(),
      onRemoveAuthor: jest.fn(),
      onReport: jest.fn(),
    };
    return {
      handlers,
      shown: wrap(
        <MessageOptionsSheet
          message={message}
          role="member"
          ownPersonId={ravi.personId}
          inhabitants={inhabitants()}
          canPost
          {...handlers}
          {...patch}
        />,
      ),
    };
  };

  it('starts a topic from another person’s message, asks the Explainer about it, argues the other side, challenges it and marks it useful', async () => {
    const message = text(1, asha, 'So the Moon alone explains the tides');
    const { handlers, shown } = open(message);
    await shown;
    expect(screen.getByTestId('option-ask-about')).toHaveTextContent('Ask Nova about this');
    expect(screen.getByText('Halley argues the opposite.')).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('option-start-topic'));
    expect(handlers.onStartTopic).toHaveBeenCalledWith(message);
    await fireEvent.press(screen.getByTestId('option-ask-about'));
    expect(handlers.onAsk).toHaveBeenCalledWith('about', message.messageId);
    await fireEvent.press(screen.getByTestId('option-ask-other_side'));
    expect(handlers.onAsk).toHaveBeenCalledWith('other_side', message.messageId);
    await fireEvent.press(screen.getByTestId('option-ask-challenge'));
    expect(handlers.onAsk).toHaveBeenCalledWith('challenge', message.messageId);
    await fireEvent.press(screen.getByTestId('option-useful'));
    expect(handlers.onUseful).toHaveBeenCalledWith(message.messageId, true);
  });

  it('offers to take a mark back, and never offers Useful on one’s own message', async () => {
    const marked = { ...text(1, asha, 'words'), usefulByYou: true } as RoomMessage;
    const { handlers, shown } = open(marked);
    await shown;
    await fireEvent.press(screen.getByTestId('option-useful'));
    expect(handlers.onUseful).toHaveBeenCalledWith(marked.messageId, false);
  });

  it('leaves Useful off one’s own message, which can still be asked about and started from', async () => {
    const { shown } = open(text(1, ravi, 'my own words'));
    await shown;
    expect(screen.queryByTestId('option-useful')).not.toBeOnTheScreen();
    expect(screen.getByTestId('option-start-topic')).toBeOnTheScreen();
    expect(screen.getByTestId('option-ask-challenge')).toBeOnTheScreen();
  });

  it('names a resident that cannot be asked and the reason, with its button off', async () => {
    const { handlers, shown } = open(text(1, asha, 'words'), { inhabitants: inhabitants('resting') });
    await shown;
    expect(screen.getAllByText('Halley is resting for now.').length).toBeGreaterThan(0);
    await fireEvent.press(screen.getByTestId('option-ask-challenge'));
    expect(handlers.onAsk).not.toHaveBeenCalled();
  });

  it('offers no asking and no topic in a room that is paused, and none on a card a topic left', async () => {
    const { shown } = open(text(1, asha, 'words'), { canPost: false });
    await shown;
    expect(screen.queryByTestId('option-ask-about')).not.toBeOnTheScreen();
    expect(screen.queryByTestId('option-start-topic')).not.toBeOnTheScreen();
  });
});

describe('starting a topic', () => {
  const sheet = (patch: Partial<React.ComponentProps<typeof StartTopicSheet>> = {}) => {
    const onStart = jest.fn();
    return {
      onStart,
      shown: wrap(
        <StartTopicSheet
          visible
          from="So the Moon alone explains the tides"
          suggestedTitle="So the Moon alone explains the tides"
          working={false}
          onClose={jest.fn()}
          onStart={onStart}
          {...patch}
        />,
      ),
    };
  };

  it('offers the first words as the title to edit and one of four tags, and starts with both', async () => {
    const { onStart, shown } = sheet();
    await shown;
    expect(screen.getByTestId('start-topic-title')).toHaveDisplayValue('So the Moon alone explains the tides');
    await fireEvent.changeText(screen.getByTestId('start-topic-title'), 'Is it only the Moon?');
    await fireEvent.press(screen.getByTestId('start-topic-tag-question'));
    await fireEvent.press(screen.getByTestId('start-topic-submit'));
    expect(onStart).toHaveBeenCalledWith('Is it only the Moon?', 'question');
  });

  it('lets a chosen tag go on a second tap, and starts without one', async () => {
    const { onStart, shown } = sheet();
    await shown;
    await fireEvent.press(screen.getByTestId('start-topic-tag-share'));
    await fireEvent.press(screen.getByTestId('start-topic-tag-share'));
    await fireEvent.press(screen.getByTestId('start-topic-submit'));
    expect(onStart).toHaveBeenCalledWith('So the Moon alone explains the tides', undefined);
  });

  it('does not start without a title', async () => {
    const { onStart, shown } = sheet({ suggestedTitle: '   ' });
    await shown;
    await fireEvent.press(screen.getByTestId('start-topic-submit'));
    expect(onStart).not.toHaveBeenCalled();
  });
});

describe('the welcome and while you were away', () => {
  const welcome = {
    resident: { kind: 'ai' as const, inhabitant: 'explainer' as const, name: 'Nova', label: 'AI · Explainer' },
    text: 'Welcome to Space room. Ask me anything here, or just say hello in General.',
  };
  const away = (patch: Partial<RoomAway> = {}): RoomAway => ({
    resident: { kind: 'ai', inhabitant: 'skeptic', name: 'Halley', label: 'AI · Skeptic' },
    since: '2026-10-23T20:00:00.000Z',
    state: 'ready',
    text: 'Two people compared dark matter with modified gravity.',
    coversFrom: '2026-10-23T20:00:00.000Z',
    ...patch,
  });

  it('puts the resident’s welcome, labelled as AI, ahead of the notice', async () => {
    await wrap(<AiNoticeCard busy={false} welcome={welcome} onAcknowledge={jest.fn()} />);
    expect(screen.getByTestId('room-welcome')).toHaveTextContent(/Nova/);
    expect(screen.getByTestId('room-welcome')).toHaveTextContent(/Welcome to Space room\./);
    expect(screen.getByRole('text', { name: 'AI, Explainer' })).toBeOnTheScreen();
  });

  it('shows what the resident wrote, who wrote it, and goes when it has been read', async () => {
    const onDismiss = jest.fn();
    await wrap(
      <AwayCard away={away()} now={new Date('2026-10-24T08:00:00.000Z')} busy={false} onDismiss={onDismiss} />,
    );
    expect(screen.getByTestId('away-card')).toHaveTextContent(/Halley/);
    expect(screen.getByRole('text', { name: 'AI, Skeptic' })).toBeOnTheScreen();
    expect(screen.getByTestId('away-text')).toHaveTextContent(/Two people compared dark matter/);
    await fireEvent.press(screen.getByTestId('away-dismiss'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('says the resident is still writing, with no words', async () => {
    const preparing = away({ state: 'preparing' });
    const { text: _text, coversFrom: _from, ...bare } = preparing;
    await wrap(<AwayCard away={bare} now={new Date('2026-10-24T08:00:00.000Z')} busy={false} onDismiss={jest.fn()} />);
    expect(screen.getByTestId('away-preparing')).toHaveTextContent(/Halley is catching you up/);
    expect(screen.queryByTestId('away-text')).not.toBeOnTheScreen();
  });

  it('folds the words to one line for a Quieter reader until they ask', async () => {
    await wrap(
      <AwayCard
        away={away({ folded: true })}
        now={new Date('2026-10-24T08:00:00.000Z')}
        busy={false}
        onDismiss={jest.fn()}
      />,
    );
    expect(screen.getByTestId('away-card')).toHaveTextContent(/Halley caught you up\./);
    expect(screen.queryByTestId('away-text')).not.toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('away-show'));
    expect(screen.getByTestId('away-text')).toBeOnTheScreen();
  });
});

describe('the limits in the room menu', () => {
  it('states the asked and the unprompted bounds from the numbers the room sends', async () => {
    await wrap(
      <AiHere
        you={{ aiLevel: 'lively', keepOut: false }}
        working={false}
        limits={{
          asked: { perPersonPerHour: 10, perRoomPerDay: 80 },
          unprompted: { humanMessagesPerTurn: 3, perHour: 8, perDay: 40, explainerPerHour: 4, skepticPerHour: 3 },
        }}
        onChange={jest.fn()}
      />,
    );
    expect(screen.getByTestId('limits-asked')).toHaveTextContent(/10 asks an hour each, and 80 a day for the room/);
    expect(screen.getByTestId('limits-asked')).toHaveTextContent(/never uses up what AI may say on its own/);
    expect(screen.getByTestId('limits-unprompted')).toHaveTextContent(/one turn for every 3 messages/);
    expect(screen.getByTestId('limits-unprompted')).toHaveTextContent(/8 an hour and 40 a day/);
  });
});
