import { describe, expect, it } from 'vitest';
import {
  ContentThreadViewSchema,
  CreateContentThreadSchema,
  MAX_THREAD_FRIENDS,
  ReactToThreadMessageSchema,
  SendThreadBodySchema,
  SendThreadMessageSchema,
  SetThreadPlaceHiddenSchema,
  SetThreadPlaceSchema,
  SnippetAnchorSchema,
  ThreadMessageSchema,
  ThreadPlaceSchema,
  ThreadPlacesSchema,
  ThreadSummarySchema,
} from './threads.js';

const id = (n: number) => `0199a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const person = { kind: 'person' as const, personId: id(10), handle: 'ci.asha', displayName: 'Asha' };
const target = { assetId: id(30), assetRevision: 1 };
const available = {
  status: 'available' as const,
  target,
  metadata: { kind: 'reel' as const, title: 'The edge', summary: '', language: 'en' },
};
const scope = { accountId: id(1), privacyEpoch: 1 };
const ref = { threadId: id(2), membershipId: id(3), membershipRevision: 1 };

describe('creating a thread', () => {
  const base = { version: 'content-thread.v1', commandId: id(5), root: target, friendPersonIds: [id(11)] };
  it('takes one to eight distinct friends and an optional plain name', () => {
    expect(CreateContentThreadSchema.safeParse(base).success).toBe(true);
    expect(CreateContentThreadSchema.safeParse({ ...base, name: 'Black holes' }).success).toBe(true);
    const many = Array.from({ length: MAX_THREAD_FRIENDS }, (_, index) => id(20 + index));
    expect(CreateContentThreadSchema.safeParse({ ...base, friendPersonIds: many }).success).toBe(true);
    expect(CreateContentThreadSchema.safeParse({ ...base, friendPersonIds: [...many, id(99)] }).success).toBe(false);
  });
  it('refuses nobody, the same person twice, a blank or padded name and unknown fields', () => {
    for (const patch of [
      { friendPersonIds: [] },
      { friendPersonIds: [id(11), id(11)] },
      { name: '  ' },
      { name: ' padded ' },
      { name: 'x'.repeat(81) },
      { admin: true },
    ])
      expect(CreateContentThreadSchema.safeParse({ ...base, ...patch }).success).toBe(false);
  });
});

describe('snippet anchors', () => {
  it('accept the three kinds, and nothing that is not part of them', () => {
    expect(SnippetAnchorSchema.safeParse({ kind: 'reel_range', startMs: 18_000, endMs: 31_000 }).success).toBe(true);
    expect(
      SnippetAnchorSchema.safeParse({
        kind: 'scroll_passage',
        blockId: 'crowd-p1',
        start: 0,
        end: 9,
        quoteHash: 'a'.repeat(64),
      }).success,
    ).toBe(true);
    expect(
      SnippetAnchorSchema.safeParse({
        kind: 'scroll_block',
        blockId: 'length-sim',
        blockType: 'simulation',
        blockVersion: 1,
      }).success,
    ).toBe(true);
    expect(SnippetAnchorSchema.safeParse({ kind: 'reel_range', startMs: 1, endMs: 2, url: 'https://x' }).success).toBe(
      false,
    );
    expect(SnippetAnchorSchema.safeParse({ kind: 'scroll_passage', blockId: 'a', start: 0, end: 5 }).success).toBe(
      false,
    );
    expect(SnippetAnchorSchema.safeParse({ kind: 'script', code: 'alert(1)' }).success).toBe(false);
  });
  it('carry block settings only as a snapshot with an explicit confirmation flag', () => {
    const settings = { snapshot: { state: { type: 'simulation', params: { len: 4096 } }, personalIncluded: false } };
    const anchor = { kind: 'scroll_block', blockId: 'length-sim', blockType: 'simulation', blockVersion: 1 };
    expect(SnippetAnchorSchema.safeParse({ ...anchor, settings }).success).toBe(true);
    expect(SnippetAnchorSchema.safeParse({ ...anchor, settings: { ...settings, confirmPersonal: true } }).success).toBe(
      true,
    );
    expect(SnippetAnchorSchema.safeParse({ ...anchor, settings: { ...settings, html: '<b>x</b>' } }).success).toBe(
      false,
    );
  });
  it('send as a snippet message with an exact revision and an optional note', () => {
    const body = {
      kind: 'snippet',
      target,
      anchor: { kind: 'reel_range', startMs: 1_000, endMs: 5_000 },
      note: 'Look',
    };
    expect(SendThreadBodySchema.safeParse(body).success).toBe(true);
    expect(SendThreadBodySchema.safeParse({ ...body, note: '' }).success).toBe(false);
    expect(SendThreadBodySchema.safeParse({ kind: 'text', text: 'hello' }).success).toBe(true);
  });
});

describe('what a thread answer can carry', () => {
  it('has no field for anyone’s position, current episode or seen marker', () => {
    const view = {
      version: 'content-thread.v1',
      readId: id(7),
      scope,
      status: 'ready',
      thread: ref,
      root: available,
      participants: [{ person, role: 'starter', joined: true, you: true }],
      sequence: { kind: 'single' },
      episodes: [{ ...target, kind: 'reel', title: 'The edge', state: 'ready', visited: false }],
      own: { readThroughSequence: 0, muted: false },
      latestMessageSequence: 0,
      messages: [],
      limit: 30,
      history: { kind: 'end' },
      catchUpCursor: `kcc1_${'A'.repeat(30)}`,
    };
    expect(ContentThreadViewSchema.safeParse(view).success).toBe(true);
    for (const extra of [{ playbackPositionMs: 5 }, { currentEpisode: id(30) }, { seenBy: [id(10)] }]) {
      expect(ContentThreadViewSchema.safeParse({ ...view, ...extra }).success).toBe(false);
      expect(
        ContentThreadViewSchema.safeParse({
          ...view,
          participants: [{ person, role: 'starter', joined: true, you: true, ...extra }],
        }).success,
      ).toBe(false);
      expect(
        ContentThreadViewSchema.safeParse({
          ...view,
          episodes: [{ ...target, kind: 'reel', title: 'The edge', state: 'ready', visited: false, ...extra }],
        }).success,
      ).toBe(false);
    }
  });
  it('keeps the order and uniqueness of messages, and shows a removed message with nothing in it', () => {
    const text = (sequence: number) => ({
      messageId: id(100 + sequence),
      sequence,
      status: 'available' as const,
      author: person,
      recordedAt: '2026-10-24T08:00:00.000Z',
      body: { kind: 'text' as const, text: 'hi' },
    });
    expect(ThreadMessageSchema.safeParse(text(1)).success).toBe(true);
    expect(ThreadMessageSchema.safeParse({ messageId: id(1), sequence: 2, status: 'unavailable' }).success).toBe(true);
    expect(
      ThreadMessageSchema.safeParse({ messageId: id(1), sequence: 2, status: 'unavailable', author: person }).success,
    ).toBe(false);
  });
  it('lists a thread for Talk without messages or counts when it is an invitation', () => {
    const summary = {
      thread: ref,
      root: available,
      state: 'invited',
      ownPersonId: id(10),
      people: [person],
      latestMessageSequence: 0,
      own: { readThroughSequence: 0, muted: false },
      lastActivityAt: '2026-10-24T08:00:00.000Z',
    };
    expect(ThreadSummarySchema.safeParse(summary).success).toBe(true);
    expect(ThreadSummarySchema.safeParse({ ...summary, people: [] }).success).toBe(false);
  });
});

describe('replies and reactions in a thread (v3 T-B)', () => {
  const send = {
    version: 'content-thread.v1',
    commandId: id(70),
    thread: ref,
    body: { kind: 'text', text: 'wait, really?' },
  };
  it('names the message a reply answers, by ID', () => {
    expect(SendThreadMessageSchema.safeParse({ ...send, replyTo: id(71) }).success).toBe(true);
    expect(SendThreadMessageSchema.safeParse({ ...send, replyTo: 'x' }).success).toBe(false);
  });
  it('states a wanted reaction, one of five', () => {
    const react = {
      version: 'content-thread.v1',
      commandId: id(72),
      thread: ref,
      messageId: id(71),
      kind: 'mind_blown',
      present: true,
    };
    expect(ReactToThreadMessageSchema.safeParse(react).success).toBe(true);
    expect(ReactToThreadMessageSchema.safeParse({ ...react, kind: 'angry' }).success).toBe(false);
    expect(ReactToThreadMessageSchema.safeParse({ ...react, present: 1 }).success).toBe(false);
  });
  it('lets a thread message carry reactions and a quote like a direct one', () => {
    const message = {
      messageId: id(73),
      sequence: 2,
      status: 'available',
      author: person,
      recordedAt: '2026-10-31T08:00:00.000Z',
      body: { kind: 'text', text: 'hello' },
      reactions: [{ kind: 'ha', mine: true, people: [person] }],
      replyTo: { messageId: id(71), sequence: 1, original: { status: 'unavailable' } },
    };
    expect(ThreadMessageSchema.safeParse(message).success).toBe(true);
  });
});

describe('party places (v3 T-D, D-065)', () => {
  const place = { person, you: false, part: 2, state: 'on', day: '2026-10-31' };
  const answer = { version: 'content-thread.v1', readId: id(80), scope, status: 'ready', thread: ref, hidden: false };

  it('is a part, on or finished, and a calendar day', () => {
    expect(ThreadPlaceSchema.safeParse(place).success).toBe(true);
    expect(ThreadPlaceSchema.safeParse({ ...place, state: 'finished' }).success).toBe(true);
    expect(ThreadPlaceSchema.safeParse({ ...place, part: 0 }).success).toBe(false);
    expect(ThreadPlaceSchema.safeParse({ ...place, part: 100 }).success).toBe(false);
    expect(ThreadPlaceSchema.safeParse({ ...place, state: 'watching' }).success).toBe(false);
  });

  it('cannot carry a time finer than a day, a playhead, a branch or a selected episode', () => {
    for (const day of ['2026-10-31T13:02:00.000Z', '2026-10-31T13:02', '13:02', '2026-10-31 13:02', '1730379720000'])
      expect(ThreadPlaceSchema.safeParse({ ...place, day }).success).toBe(false);
    for (const extra of [
      { playbackPositionMs: 5 },
      { positionMs: 5 },
      { branch: id(9) },
      { selectedEpisode: id(30) },
      { seenAt: '2026-10-31T13:02:00.000Z' },
      { updatedAt: '2026-10-31T13:02:00.000Z' },
    ])
      expect(ThreadPlaceSchema.safeParse({ ...place, ...extra }).success).toBe(false);
  });

  it('lists each person once, at most the thread’s members', () => {
    expect(ThreadPlacesSchema.safeParse({ ...answer, places: [place] }).success).toBe(true);
    expect(ThreadPlacesSchema.safeParse({ ...answer, places: [place, place] }).success).toBe(false);
    const people = Array.from({ length: MAX_THREAD_FRIENDS + 2 }, (_, index) => ({
      ...place,
      person: { ...person, personId: id(100 + index) },
    }));
    expect(ThreadPlacesSchema.safeParse({ ...answer, places: people }).success).toBe(false);
    expect(ThreadPlacesSchema.safeParse({ ...answer, status: 'unavailable', thread: undefined }).success).toBe(false);
    expect(
      ThreadPlacesSchema.safeParse({ version: 'content-thread.v1', readId: id(80), scope, status: 'unavailable' })
        .success,
    ).toBe(true);
  });

  it('is reported as a part and a state, with no time and nothing else', () => {
    const set = { version: 'content-thread.v1', commandId: id(81), thread: ref, part: 2, state: 'finished' };
    expect(SetThreadPlaceSchema.safeParse(set).success).toBe(true);
    for (const patch of [
      { part: 0 },
      { state: 'watching' },
      { day: '2026-10-31' },
      { positionMs: 5 },
      { recordedAt: '2026-10-31T13:02:00.000Z' },
    ])
      expect(SetThreadPlaceSchema.safeParse({ ...set, ...patch }).success).toBe(false);
  });

  it('states a wanted hide', () => {
    const hide = { version: 'content-thread.v1', commandId: id(82), thread: ref, hidden: true };
    expect(SetThreadPlaceHiddenSchema.safeParse(hide).success).toBe(true);
    expect(SetThreadPlaceHiddenSchema.safeParse({ ...hide, hidden: 'yes' }).success).toBe(false);
  });
});
