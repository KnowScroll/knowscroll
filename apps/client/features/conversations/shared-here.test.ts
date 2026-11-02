import type { ConversationMessage } from '@knowscroll/contracts';
import { sharedHere } from './shared-here';

const id = (n: number) => `0199a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const me = { kind: 'person' as const, personId: id(1), handle: 'ci.asha', displayName: 'Asha' };
const peer = { kind: 'person' as const, personId: id(2), handle: 'ci.ravi', displayName: 'Ravi' };
const card = (sequence: number, author: typeof me, title: string, status: 'available' | 'unavailable' = 'available') =>
  ({
    messageId: id(100 + sequence),
    sequence,
    status: 'available',
    author,
    recordedAt: `2026-10-2${String(sequence)}T08:00:00.000Z`,
    body: {
      kind: 'content',
      content:
        status === 'available'
          ? {
              status: 'available',
              target: { assetId: id(300 + sequence), assetRevision: 1 },
              metadata: { kind: sequence % 2 === 0 ? 'reel' : 'scroll', title, summary: '', language: 'en' },
            }
          : { status: 'unavailable', target: { assetId: id(300 + sequence), assetRevision: 1 } },
    },
  }) as unknown as ConversationMessage;
const words = (sequence: number, author: typeof me): ConversationMessage =>
  ({
    messageId: id(100 + sequence),
    sequence,
    status: 'available',
    author,
    recordedAt: '2026-10-21T08:00:00.000Z',
    body: { kind: 'text', text: 'hello' },
  }) as unknown as ConversationMessage;

describe('what was shared in a conversation', () => {
  it('lists the cards that were sent, newest first, saying who sent each', () => {
    const shared = sharedHere([card(1, peer, 'Tides'), words(2, me), card(3, me, 'The edge')], peer);
    expect(shared.map((entry) => [entry.title, entry.by])).toEqual([
      ['The edge', 'You'],
      ['Tides', 'Ravi'],
    ]);
  });

  it('leaves out a card that is gone, and lists nothing for a chat with no cards', () => {
    expect(sharedHere([card(1, peer, 'x', 'unavailable'), words(2, me)], peer)).toEqual([]);
    expect(sharedHere([], peer)).toEqual([]);
  });
});
