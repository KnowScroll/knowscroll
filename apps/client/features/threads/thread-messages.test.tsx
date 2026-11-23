import { createRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import type { ScenarioCard, ThreadMessage } from '@knowscroll/contracts';
import type { ContentThreadController, ContentThreadState } from '@knowscroll/client-core';
import { DisplayProvider } from '@knowscroll/ui';
import { MadeToOrderContext, type MadeToOrderState } from '../../providers/made-to-order';
import { ThreadMessages } from './thread-messages';

/**
 * What if and Another perspective in a thread, and the branch cards they make, are drawn only while the API says the Scrolls
 * made to order are on (D-436). Off, the thread is the thread without them: the messages, in the order they were said.
 */
const id = (n: number) => `0199a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const asha = { kind: 'person' as const, personId: id(90), handle: 'ci.asha', displayName: 'Asha' };
const ravi = { kind: 'person' as const, personId: id(91), handle: 'ci.ravi', displayName: 'Ravi' };
const text: ThreadMessage = {
  messageId: id(1),
  sequence: 1,
  status: 'available',
  author: ravi,
  recordedAt: '2026-10-24T10:00:00.000Z',
  body: { kind: 'text', text: 'Why does it cost so much?' },
};
const moment: ThreadMessage = {
  messageId: id(2),
  sequence: 2,
  status: 'available',
  author: ravi,
  recordedAt: '2026-10-24T10:05:00.000Z',
  body: {
    kind: 'snippet',
    snippet: {
      kind: 'reel_range',
      startMs: 1000,
      endMs: 9000,
      content: {
        status: 'available',
        target: { assetId: id(5), assetRevision: 1 },
        metadata: { kind: 'reel', title: 'Serving costs', summary: '', language: 'en' },
      },
    },
  },
} as unknown as ThreadMessage;
const branch: ScenarioCard = {
  nodeId: id(100),
  kind: 'what_if',
  origin: 'root',
  title: 'What happens at ten times the traffic?',
  changes: [],
  kept: [],
  hypothetical: true,
  speculative: false,
  assumptions: [],
  status: 'preparing',
  revision: 1,
  createdAt: '2026-10-24T10:02:00.000Z',
};

const state = {
  messages: [text, moment],
  outgoing: [],
  episodes: [],
  sequence: 'single',
  hasOlder: false,
  loadingOlder: false,
} as unknown as ContentThreadState;

async function show(value: MadeToOrderState) {
  const onAsk = jest.fn();
  await render(
    <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
      <MadeToOrderContext.Provider value={value}>
        <ThreadMessages
          state={state}
          controller={{} as ContentThreadController}
          ownPersonId={asha.personId}
          episodes={[]}
          scrollRef={createRef()}
          onScroll={jest.fn()}
          onOpenSnippet={jest.fn()}
          branches={[branch]}
          openedBranches={[]}
          onOpenBranch={jest.fn()}
          onRemoveBranch={jest.fn()}
          onContinueBranch={jest.fn()}
          onAsk={onAsk}
          onReply={jest.fn()}
          onReport={jest.fn()}
        />
      </MadeToOrderContext.Provider>
    </DisplayProvider>,
  );
  return onAsk;
}

describe('a thread and the made-to-order switch', () => {
  it('draws the branch card, the What if… under a shared moment and the message menu rows while the switch is on', async () => {
    const onAsk = await show('on');
    expect(screen.getByText('What happens at ten times the traffic?')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'What if…' }));
    expect(onAsk).toHaveBeenCalledWith(expect.objectContaining({ sequence: 2 }), 'what_if');
    await fireEvent(screen.getByTestId('bubble-1'), 'longPress');
    expect(screen.getByTestId('menu-what-if')).toBeOnTheScreen();
    expect(screen.getByTestId('menu-perspective')).toBeOnTheScreen();
  });

  for (const value of ['off', 'unknown'] as const)
    it(`draws none of them while the switch is ${value}, and keeps the messages and the rest of the menu`, async () => {
      await show(value);
      expect(screen.queryByText('What happens at ten times the traffic?')).toBeNull();
      expect(screen.queryByRole('button', { name: 'What if…' })).toBeNull();
      expect(screen.getByText('Why does it cost so much?')).toBeOnTheScreen();
      await fireEvent(screen.getByTestId('bubble-1'), 'longPress');
      expect(screen.getByTestId('menu-copy')).toBeOnTheScreen();
      expect(screen.queryByTestId('menu-what-if')).toBeNull();
      expect(screen.queryByTestId('menu-perspective')).toBeNull();
    });
});
