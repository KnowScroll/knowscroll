import { describe, expect, it } from 'vitest';
import type { MessageQuote } from '@knowscroll/contracts';
import {
  heldReactions,
  liveReplyTarget,
  messagePreview,
  quoteView,
  reactorNames,
  type QuotableMessage,
} from './talk-reply';

const id = (n: number) => `0199a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const asha = { kind: 'person' as const, personId: id(1), handle: 'ci.asha', displayName: 'Asha fixture' };
const ravi = { kind: 'person' as const, personId: id(2), handle: 'ci.ravi', displayName: 'Ravi fixture' };
type Available = Extract<QuotableMessage, { status: 'available' }>;
const text = (sequence: number, value: string, author = ravi): Available => ({
  status: 'available',
  messageId: id(100 + sequence),
  sequence,
  author,
  recordedAt: '2026-10-26T12:58:00.000Z',
  body: { kind: 'text', text: value },
});
const quote = (original: MessageQuote['original']): MessageQuote => ({ messageId: id(101), sequence: 1, original });

describe('message previews', () => {
  it('take the first words of a text or a card note, on one line, cut with an ellipsis', () => {
    expect(messagePreview(text(1, '  moon ka\nbulge  '))).toBe('moon ka bulge');
    expect(messagePreview({ ...text(1, ''), body: { kind: 'content', note: 'look at this' } })).toBe('look at this');
    expect(messagePreview({ ...text(1, ''), body: { kind: 'snippet' } })).toBe('');
    expect(messagePreview({ status: 'unavailable', messageId: id(1), sequence: 1 })).toBe('');
    const long = messagePreview(text(1, 'x'.repeat(300)));
    expect([...long]).toHaveLength(120);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('the quote of a reply', () => {
  const server = quote({ status: 'available', author: ravi, preview: 'what the server sent' });
  it('uses the words the server sent when the original is not loaded', () => {
    expect(quoteView(server, [])).toEqual({
      messageId: id(101),
      sequence: 1,
      author: 'Ravi fixture',
      preview: 'what the server sent',
    });
  });
  it('prefers the reader’s own copy of the original, which is newer', () => {
    expect(quoteView(server, [text(1, 'what I hold')]).preview).toBe('what I hold');
  });
  it('calls the reader’s own words "You", whether the copy is loaded or only the server’s words are', () => {
    const mine = quote({ status: 'available', author: asha, preview: 'what the server sent' });
    expect(quoteView(mine, [], asha.personId).author).toBe('You');
    expect(quoteView(mine, [text(1, 'what I hold', asha)], asha.personId).author).toBe('You');
    expect(quoteView(mine, [text(1, 'what I hold', asha)], ravi.personId).author).toBe('Asha fixture');
    expect(quoteView(mine, []).author).toBe('Asha fixture');
  });
  it('says the original is gone, and offers no words, once its tombstone arrived or the server says so', () => {
    const gone = { messageId: id(101), sequence: 1, author: undefined, preview: '' };
    expect(quoteView(server, [{ status: 'unavailable', messageId: id(101), sequence: 1 }])).toEqual(gone);
    expect(quoteView(quote({ status: 'unavailable' }), [])).toEqual(gone);
  });
});

describe('a waiting reply', () => {
  const sent = text(1, 'who is on part 2?');
  it('is kept while its original stands, or is not loaded, and goes once the reader’s copy is a tombstone', () => {
    expect(liveReplyTarget(sent, [sent])).toBe(sent);
    expect(liveReplyTarget(sent, [])).toBe(sent);
    expect(liveReplyTarget(sent, [{ status: 'unavailable', messageId: sent.messageId, sequence: 1 }])).toBeUndefined();
    expect(liveReplyTarget(undefined, [sent])).toBeUndefined();
  });
});

describe('reactions', () => {
  it('lists which the reader holds', () => {
    const message = {
      ...text(1, 'hello'),
      reactions: [
        { kind: 'heart' as const, mine: true, people: [asha] },
        { kind: 'ha' as const, mine: false, people: [ravi] },
      ],
    };
    expect([...heldReactions(message)]).toEqual(['heart']);
    expect([...heldReactions({ status: 'unavailable', messageId: id(1), sequence: 1 })]).toEqual([]);
  });
  it('names the reader first as You, then the others by name', () => {
    expect(reactorNames([ravi, asha], asha.personId)).toEqual(['You', 'Ravi fixture']);
    expect(reactorNames([ravi, asha], undefined)).toEqual(['Asha fixture', 'Ravi fixture']);
  });
});
