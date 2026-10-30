import { describe, expect, it } from 'vitest';
import type { DirectConversationSummary } from '@knowscroll/contracts';
import {
  capsuleLabel,
  clockTime,
  dayKey,
  dayLabel,
  describeMessage,
  endsRun,
  inboxRowView,
  listTime,
} from './talk-format';

const id = (n: number) => `0199a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const peer = { kind: 'person' as const, personId: id(1), handle: 'ravi', displayName: 'Ravi' };
const me = { kind: 'person' as const, personId: id(2), handle: 'asha', displayName: 'Asha' };
const metadata = { kind: 'reel' as const, title: 'What one answer costs to serve', summary: '', language: 'en' };
const target = { assetId: id(3), assetRevision: 1 };
const message = (author: typeof peer, body: object, sequence = 1) =>
  ({
    messageId: id(100 + sequence),
    sequence,
    status: 'available',
    author,
    recordedAt: '2026-10-24T09:40:00.000Z',
    body,
  }) as never;

describe('message descriptions', () => {
  it('say "You:" for the reader’s own text and show the peer’s plainly', () => {
    expect(describeMessage(message(me, { kind: 'text', text: 'the orbit Scroll is worth it' }), peer.personId)).toBe(
      'You: the orbit Scroll is worth it',
    );
    expect(describeMessage(message(peer, { kind: 'text', text: 'Hello' }), peer.personId)).toBe('Hello');
  });
  it('describe a card by its kind and title, including a corrected or unavailable one', () => {
    const card = (content: object) => message(peer, { kind: 'content', content });
    expect(describeMessage(card({ status: 'available', target, metadata }), peer.personId)).toBe(
      'Shared a Reel · What one answer costs to serve',
    );
    expect(
      describeMessage(
        card({
          status: 'corrected',
          target,
          current: { ...target, assetRevision: 2, metadata: { ...metadata, kind: 'scroll', title: 'Updated' } },
        }),
        peer.personId,
      ),
    ).toBe('Shared a Scroll · Updated');
    expect(describeMessage(card({ status: 'unavailable', target }), peer.personId)).toBe(
      'Shared content · no longer available',
    );
    expect(
      describeMessage(
        message(me, { kind: 'content', content: { status: 'available', target, metadata } }),
        peer.personId,
      ),
    ).toBe('You shared a Reel · What one answer costs to serve');
  });
  it('show a tombstone as removed', () => {
    expect(describeMessage({ messageId: id(1), sequence: 1, status: 'unavailable' }, peer.personId)).toBe(
      'Message removed',
    );
  });
});

describe('inbox rows', () => {
  const summary = (last: object, readThrough: number, latest = 1): DirectConversationSummary =>
    ({
      conversation: { conversationId: id(9), membershipId: id(8), membershipRevision: 1 },
      peer,
      latestMessageSequence: latest,
      own: { readThroughSequence: readThrough, muted: false },
      lastMessage: last,
    }) as never;
  it('are unread when the newest message is the peer’s and past the read position', () => {
    expect(inboxRowView(summary(message(peer, { kind: 'text', text: 'hi' }), 0)).unread).toBe(true);
    expect(inboxRowView(summary(message(peer, { kind: 'text', text: 'hi' }), 1)).unread).toBe(false);
    expect(inboxRowView(summary(message(me, { kind: 'text', text: 'hi' }), 0)).unread).toBe(false);
  });
});

describe('list times', () => {
  const now = new Date(2026, 9, 24, 12, 0);
  it('show the time today, then Yesterday, a weekday, a date', () => {
    expect(listTime(new Date(2026, 9, 24, 9, 40), now, 'en-GB')).toMatch(/^0?9:40$/);
    expect(listTime(new Date(2026, 9, 23, 23, 59), now, 'en-GB')).toBe('Yesterday');
    expect(listTime(new Date(2026, 9, 20, 9, 40), now, 'en-GB')).toBe('Tue');
    expect(listTime(new Date(2026, 9, 1, 9, 40), now, 'en-GB')).toBe('1 Oct');
  });
});

describe('day dividers', () => {
  const now = new Date(2026, 9, 24, 12, 0);
  it('say Today and Yesterday, then the date', () => {
    expect(dayLabel(new Date(2026, 9, 24, 0, 5), now, 'en-GB')).toBe('Today');
    expect(dayLabel(new Date(2026, 9, 23, 23, 59), now, 'en-GB')).toBe('Yesterday');
    expect(dayLabel(new Date(2026, 9, 12, 9, 40), now, 'en-GB')).toBe('12 Oct');
  });
  it('group by calendar day in the reader’s own time zone', () => {
    expect(dayKey(new Date(2026, 9, 24, 0, 1))).toBe(dayKey(new Date(2026, 9, 24, 23, 59)));
    expect(dayKey(new Date(2026, 9, 24, 12))).not.toBe(dayKey(new Date(2026, 9, 25, 12)));
  });
});

describe('runs of messages', () => {
  const step = (authorId: string, hour: number, minute: number, day = 24) => ({
    authorId,
    at: new Date(2026, 9, day, hour, minute),
  });
  it('end at the last message before another author, a pause of five minutes or a new day', () => {
    expect(endsRun(step('a', 9, 0), undefined)).toBe(true);
    expect(endsRun(step('a', 9, 0), step('b', 9, 1))).toBe(true);
    expect(endsRun(step('a', 9, 0), step('a', 9, 4))).toBe(false);
    expect(endsRun(step('a', 9, 0), step('a', 9, 5))).toBe(true);
    expect(endsRun(step('a', 23, 59), step('a', 0, 1, 25))).toBe(true);
  });
  it('show the clock time in the reader’s own time zone', () => {
    expect(clockTime(new Date(2026, 9, 24, 18, 40), 'en-GB')).toBe('18:40');
  });
});

describe('the day capsule', () => {
  const now = new Date(2026, 9, 26, 15, 0);
  it('says Today and Yesterday, then the weekday, day and month, and the year once it is not this year', () => {
    expect(capsuleLabel(new Date(2026, 9, 26, 0, 5), now, 'en-GB')).toBe('Today');
    expect(capsuleLabel(new Date(2026, 9, 25, 23, 59), now, 'en-GB')).toBe('Yesterday');
    expect(capsuleLabel(new Date(2026, 9, 18, 12, 0), now, 'en-GB')).toBe('Sun 18 Oct');
    expect(capsuleLabel(new Date(2025, 11, 31, 12, 0), now, 'en-GB')).toBe('Wed 31 Dec 2025');
  });
});
