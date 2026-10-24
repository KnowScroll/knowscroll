import { fireEvent, render, screen } from '@testing-library/react-native';
import type { RoomDiscussionController, RoomDiscussionState } from '@knowscroll/client-core';
import type { RoomMessage } from '@knowscroll/contracts';
import { DisplayProvider } from '@knowscroll/ui';
import { actionsFor, RoomMessages } from './room-messages';

const asha = {
  kind: 'person' as const,
  personId: '0199c000-0000-7000-8000-00000000000a',
  handle: 'ci.asha',
  displayName: 'Asha',
};
const ravi = {
  kind: 'person' as const,
  personId: '0199c000-0000-7000-8000-00000000000b',
  handle: 'ci.ravi',
  displayName: 'Ravi',
};
const id = (n: number) => `0199c000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const at = '2026-10-24T08:00:00.000Z';

const text = (sequence: number, author: typeof asha, value: string): RoomMessage => ({
  messageId: id(100 + sequence),
  sequence,
  status: 'available',
  author,
  recordedAt: at,
  body: { kind: 'text', text: value },
});
const skeptic: RoomMessage = {
  messageId: id(200),
  sequence: 3,
  status: 'available',
  author: { kind: 'ai', inhabitant: 'skeptic', label: 'AI · Skeptic' },
  recordedAt: at,
  body: { kind: 'text', text: 'Does that assume requests arrive in bursts?' },
  suggestion: 'assumption',
};
const reel = { kind: 'reel' as const, title: 'What one answer costs', summary: '', language: 'en' };
const card: RoomMessage = {
  messageId: id(201),
  sequence: 4,
  status: 'available',
  author: ravi,
  recordedAt: at,
  body: {
    kind: 'content',
    content: { status: 'available', target: { assetId: id(300), assetRevision: 1 }, metadata: reel },
    note: 'look at this',
  },
};

const state = (messages: RoomMessage[], patch: Partial<RoomDiscussionState> = {}): RoomDiscussionState => ({
  phase: 'ready',
  view: undefined,
  messages,
  outgoing: [],
  hasOlder: false,
  loadingOlder: false,
  offline: false,
  asking: false,
  ...patch,
});
const controller = {
  loadOlder: jest.fn(),
  retry: jest.fn(),
  dismiss: jest.fn(),
} as unknown as RoomDiscussionController;

async function show(messages: RoomMessage[], role: 'member' | 'moderator' = 'member') {
  const onActions = jest.fn();
  const onStartThread = jest.fn();
  await render(
    <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
      <RoomMessages
        state={state(messages)}
        controller={controller}
        role={role}
        ownPersonId={asha.personId}
        episodes={[]}
        series={false}
        scrollRef={{ current: null }}
        onScroll={() => undefined}
        onOpenSnippet={() => undefined}
        onStartThread={onStartThread}
        onActions={onActions}
      />
    </DisplayProvider>,
  );
  return { onActions, onStartThread };
}

describe('room messages', () => {
  it('labels an AI inhabitant before its words, names the kind, and says nothing is made unless chosen', async () => {
    await show([text(1, asha, 'More traffic means a bigger bill?'), skeptic]);
    expect(screen.getByRole('text', { name: 'AI, Skeptic' })).toBeOnTheScreen();
    expect(screen.getByText('Does that assume requests arrive in bursts?')).toBeOnTheScreen();
    expect(screen.getByText('An assumption to check')).toBeOnTheScreen();
    expect(screen.getByText('A suggestion. Nothing is made unless someone chooses it.')).toBeOnTheScreen();
    // A person's message carries no AI label, and the caller's own is not named.
    expect(screen.queryByText('Asha')).not.toBeOnTheScreen();
  });

  it('names other people above their words and shows removed and deleted messages as markers that keep their place', async () => {
    await show([
      text(1, ravi, 'hello'),
      { messageId: id(102), sequence: 2, status: 'removed' },
      { messageId: id(103), sequence: 3, status: 'unavailable' },
    ]);
    expect(screen.getByText('Ravi')).toBeOnTheScreen();
    expect(screen.getByText('Message removed by the moderator')).toBeOnTheScreen();
    expect(screen.getByText('Message removed')).toBeOnTheScreen();
  });

  it('collapses a message from someone the reader blocked into a marker that keeps its place and shows no words', async () => {
    await show([text(1, ravi, 'hello'), { messageId: id(104), sequence: 2, status: 'blocked' }]);
    expect(screen.getByText('A message from someone you blocked')).toBeOnTheScreen();
    // Only the message that is still shown has options (to report it); the marker has none.
    expect(screen.getAllByRole('button', { name: 'Message options' })).toHaveLength(1);
  });

  it('keeps a blocked author’s words collapsed for a moderator, with a way to show them and still moderate', async () => {
    const blockedByYou: RoomMessage = {
      messageId: id(102),
      sequence: 2,
      status: 'available',
      author: ravi,
      recordedAt: at,
      body: { kind: 'text', text: 'WORDS TO MODERATE' },
      blockedByYou: true,
    };
    const moderator = await show([text(1, asha, 'hello'), blockedByYou], 'moderator');
    // Collapsed: no words and no name, but the options to remove it are there without reading it.
    expect(screen.getByText('A message from someone you blocked')).toBeOnTheScreen();
    expect(screen.queryByText('WORDS TO MODERATE')).not.toBeOnTheScreen();
    expect(screen.queryByText('Ravi')).not.toBeOnTheScreen();
    // A moderator has options on every message; the collapsed one's are the second.
    await fireEvent(screen.getByTestId('message-2'), 'hoverIn');
    await fireEvent.press(screen.getAllByRole('button', { name: 'Message options' })[1]!);
    expect(moderator.onActions).toHaveBeenCalledWith(blockedByYou);
    // Shown for moderation on request, and put away again.
    await fireEvent.press(screen.getByTestId(`show-blocked-${blockedByYou.messageId}`));
    expect(screen.getByText('WORDS TO MODERATE')).toBeOnTheScreen();
    expect(screen.getByText('You blocked this person. Shown for moderation.')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Hide again' }));
    expect(screen.queryByText('WORDS TO MODERATE')).not.toBeOnTheScreen();
  });

  it('offers message options only where there is something to do: a card, a moderator, or another person’s words to report', async () => {
    const member = await show([text(1, ravi, 'plain'), card, text(5, asha, 'mine')]);
    // Another person's plain message can be reported and their card can start a thread; your own has nothing to do.
    expect(screen.getAllByRole('button', { name: 'Message options' })).toHaveLength(2);
    await fireEvent(screen.getByTestId('message-4'), 'hoverIn');
    await fireEvent.press(screen.getAllByRole('button', { name: 'Message options' })[1]!);
    expect(member.onActions).toHaveBeenCalledWith(card);
    await fireEvent.press(screen.getByTestId('start-thread'));
    expect(member.onStartThread).toHaveBeenCalledWith(card.messageId);
  });

  it('lets a member report an AI inhabitant’s message, which has no person to block', async () => {
    const member = await show([skeptic]);
    expect(screen.getAllByRole('button', { name: 'Message options' })).toHaveLength(1);
    await fireEvent(screen.getByTestId('message-3'), 'longPress');
    expect(member.onActions).toHaveBeenCalledWith(skeptic);
  });

  it('keeps ⋯ off the message until the pointer is over it or the control has focus, yet in the page for assistive tech', async () => {
    // Your own words have no ⋯, so the card's is the only one.
    await show([text(1, asha, 'mine'), card]);
    const options = () => screen.getByRole('button', { name: 'Message options' });
    const wrapper = () => screen.getByTestId('message-options-4');
    expect(options()).toBeOnTheScreen();
    expect(wrapper()).toHaveStyle({ opacity: 0 });
    const line = screen.getByTestId('message-4');
    await fireEvent(line, 'hoverIn');
    expect(wrapper()).not.toHaveStyle({ opacity: 0 });
    await fireEvent(line, 'hoverOut');
    expect(wrapper()).toHaveStyle({ opacity: 0 });
    // Tabbing to the control itself reveals it: focus is the button's, not the line's.
    await fireEvent(options(), 'focus');
    expect(wrapper()).not.toHaveStyle({ opacity: 0 });
    await fireEvent(options(), 'blur');
    expect(wrapper()).toHaveStyle({ opacity: 0 });
  });

  it('opens the same options with a long press on the message', async () => {
    const plain = text(1, ravi, 'plain');
    const member = await show([plain, card, text(5, asha, 'mine')]);
    await fireEvent(screen.getByTestId('message-4'), 'longPress');
    expect(member.onActions).toHaveBeenCalledWith(card);
    // Another person's plain message can be reported, so it has the options too.
    await fireEvent(screen.getByTestId('message-1'), 'longPress');
    expect(member.onActions).toHaveBeenCalledWith(plain);
    // Your own words have nothing to do.
    await fireEvent(screen.getByTestId('message-5'), 'longPress');
    expect(member.onActions).toHaveBeenCalledTimes(2);
  });

  it('gives a moderator the options on every message but never on a deleted account’s', async () => {
    await show(
      [
        text(1, ravi, 'plain'),
        { messageId: id(102), sequence: 2, status: 'removed' },
        { messageId: id(103), sequence: 3, status: 'unavailable' },
      ],
      'moderator',
    );
    expect(screen.getAllByRole('button', { name: 'Message options' })).toHaveLength(2);
  });

  it('decides the actions from the message, the role and whose message it is', () => {
    expect(actionsFor(card, 'member', asha.personId)).toEqual({
      canStartThread: true,
      canModerate: false,
      canReport: true,
    });
    expect(actionsFor(text(1, ravi, 'x'), 'moderator', asha.personId)).toEqual({
      canStartThread: false,
      canModerate: true,
      canReport: true,
    });
    // Your own words and a marker have nothing to report.
    expect(actionsFor(text(1, asha, 'x'), 'member', asha.personId).canReport).toBe(false);
    expect(actionsFor({ messageId: id(1), sequence: 1, status: 'unavailable' }, 'moderator', asha.personId)).toEqual({
      canStartThread: false,
      canModerate: false,
      canReport: false,
    });
    expect(actionsFor(skeptic, 'member', asha.personId).canReport).toBe(true);
  });
});
