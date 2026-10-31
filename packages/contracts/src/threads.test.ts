import { describe, expect, it } from 'vitest';
import {
  ContentThreadViewSchema,
  CreateContentThreadSchema,
  LockThreadCallSchema,
  MAX_THREAD_FRIENDS,
  ReactToThreadMessageSchema,
  SendThreadBodySchema,
  SendThreadMessageSchema,
  SetThreadPlaceHiddenSchema,
  SetThreadPlaceSchema,
  SnippetAnchorSchema,
  ThreadCallLockAcceptanceSchema,
  ThreadCallSchema,
  ThreadCallsSchema,
  ThreadMessageSchema,
  ThreadPlaceAcceptanceSchema,
  ThreadPlaceHiddenAcceptanceSchema,
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
    const set = { version: 'content-thread.v1', thread: ref, part: 2, state: 'finished' };
    expect(SetThreadPlaceSchema.safeParse(set).success).toBe(true);
    for (const patch of [
      { part: 0 },
      { state: 'watching' },
      { day: '2026-10-31' },
      { positionMs: 5 },
      { recordedAt: '2026-10-31T13:02:00.000Z' },
      // Idempotent by state: there is no command ID to key a receipt by.
      { commandId: id(81) },
    ])
      expect(SetThreadPlaceSchema.safeParse({ ...set, ...patch }).success).toBe(false);
  });

  it('is answered with the scope and what it did, and no time, command ID or replay flag', () => {
    const answered = { version: 'content-thread.v1', scope, operation: 'thread.place', thread: ref, result: 'stored' };
    expect(ThreadPlaceAcceptanceSchema.safeParse(answered).success).toBe(true);
    for (const extra of [
      { recordedAt: '2026-10-31T13:02:00.000Z' },
      { commandId: id(81) },
      { replayed: false },
      { outcome: 'accepted' },
    ])
      expect(ThreadPlaceAcceptanceSchema.safeParse({ ...answered, ...extra }).success).toBe(false);
    const hidden = {
      version: 'content-thread.v1',
      scope,
      operation: 'thread.place-hidden',
      thread: ref,
      hidden: true,
      changed: true,
    };
    expect(ThreadPlaceHiddenAcceptanceSchema.safeParse(hidden).success).toBe(true);
    expect(
      ThreadPlaceHiddenAcceptanceSchema.safeParse({ ...hidden, recordedAt: '2026-10-31T13:02:00.000Z' }).success,
    ).toBe(false);
  });

  it('states a wanted hide', () => {
    const hide = { version: 'content-thread.v1', thread: ref, hidden: true };
    expect(SetThreadPlaceHiddenSchema.safeParse(hide).success).toBe(true);
    expect(SetThreadPlaceHiddenSchema.safeParse({ ...hide, commandId: id(82) }).success).toBe(false);
    expect(SetThreadPlaceHiddenSchema.safeParse({ ...hide, hidden: 'yes' }).success).toBe(false);
  });
});

describe('Call it together (v3 T-E, D-155 to D-157)', () => {
  const base = {
    part: 2,
    assetId: id(40),
    assetRevision: 3,
    prompt: 'When are tides biggest?',
    options: ['Full and new moon', 'Half moon', 'Always the same'],
    called: 2,
    of: 4,
  };
  const revealed = {
    ...base,
    stage: 'revealed' as const,
    option: 0,
    answer: 0,
    explain: 'Spring tides come at full and new moon.',
    right: true,
    picks: [
      { person, you: true, option: 0, right: true },
      { person: { ...person, personId: id(11) }, you: false, option: 1, right: false },
    ],
    rightCount: 1,
  };

  it('carries only what its stage may show: a pick, the right answer and who called appear only once revealed', () => {
    expect(ThreadCallSchema.safeParse({ ...base, stage: 'open' }).success).toBe(true);
    expect(ThreadCallSchema.safeParse({ ...base, stage: 'locked', option: 1 }).success).toBe(true);
    expect(ThreadCallSchema.safeParse({ ...base, stage: 'closed', reason: 'started' }).success).toBe(true);
    expect(ThreadCallSchema.safeParse(revealed).success).toBe(true);
    for (const stage of ['open', 'closed'] as const)
      for (const extra of [{ option: 1 }, { answer: 0 }, { picks: revealed.picks }, { explain: 'x' }, { right: true }])
        expect(
          ThreadCallSchema.safeParse({ ...base, stage, ...(stage === 'closed' ? { reason: 'started' } : {}), ...extra })
            .success,
          `${stage} with ${Object.keys(extra).join(',')}`,
        ).toBe(false);
    for (const extra of [{ answer: 0 }, { picks: revealed.picks }, { explain: 'x' }, { right: true }, { twist: 'x' }])
      expect(ThreadCallSchema.safeParse({ ...base, stage: 'locked', option: 1, ...extra }).success).toBe(false);
  });

  it('cannot say who was waiting, when anyone called, a time, a playhead or a score', () => {
    for (const extra of [
      { waitingFor: [person] },
      { calledBy: [person] },
      { lockedAt: '2026-10-31T13:02:00.000Z' },
      { day: '2026-10-31' },
      { positionMs: 5 },
      { sparks: 1 },
      { total: 41 },
    ])
      for (const call of [{ ...base, stage: 'open' }, { ...base, stage: 'locked', option: 1 }, revealed])
        expect(ThreadCallSchema.safeParse({ ...call, ...extra }).success).toBe(false);
  });

  it('keeps a call to two or three options, and every pick to one of them', () => {
    expect(ThreadCallSchema.safeParse({ ...base, stage: 'open', options: ['only'] }).success).toBe(false);
    expect(ThreadCallSchema.safeParse({ ...base, stage: 'open', options: ['a', 'b', 'c', 'd'] }).success).toBe(false);
    expect(ThreadCallSchema.safeParse({ ...base, stage: 'locked', option: 3 }).success).toBe(false);
    expect(ThreadCallSchema.safeParse({ ...revealed, picks: [{ ...revealed.picks[0]!, option: 3 }] }).success).toBe(
      false,
    );
  });

  it('lists each person once in a reveal, and the common guess is only the Scroll’s reviewed source', () => {
    expect(ThreadCallSchema.safeParse({ ...revealed, picks: [revealed.picks[0], revealed.picks[0]] }).success).toBe(
      false,
    );
    expect(ThreadCallSchema.safeParse({ ...revealed, guessSource: 'A Private Universe' }).success).toBe(true);
    // Nothing counted from other threads can be said: no percent, no number of calls, no person.
    for (const extra of [
      { commonGuess: { option: 1, percent: 62 } },
      { percent: 62 },
      { calls: 41 },
      { guessSource: 'A Private Universe', people: [person] },
    ])
      expect(ThreadCallSchema.safeParse({ ...revealed, ...extra }).success).toBe(false);
    expect(ThreadCallSchema.safeParse({ ...revealed, guessSource: 62 }).success).toBe(false);
  });

  it('says a Scroll was updated since the thread called only as held or restarted, in every stage', () => {
    for (const updated of ['held', 'restarted'])
      for (const call of [{ ...base, stage: 'open' }, { ...base, stage: 'locked', option: 1 }, revealed])
        expect(ThreadCallSchema.safeParse({ ...call, updated }).success).toBe(true);
    for (const updated of ['current', true, 2, ''])
      expect(ThreadCallSchema.safeParse({ ...base, stage: 'open', updated }).success).toBe(false);
  });

  it('is read for a thread, with one call at most for each part', () => {
    const answer = { version: 'content-thread.v1', readId: id(80), scope, status: 'ready', thread: ref };
    const open = { ...base, stage: 'open' };
    expect(ThreadCallsSchema.safeParse({ ...answer, calls: [open] }).success).toBe(true);
    expect(ThreadCallsSchema.safeParse({ ...answer, calls: [open, open] }).success).toBe(false);
    expect(
      ThreadCallsSchema.safeParse({ version: 'content-thread.v1', readId: id(80), scope, status: 'unavailable' })
        .success,
    ).toBe(true);
  });

  it('is locked with a part and a pick, and nothing that says whether it was right', () => {
    const lock = {
      version: 'content-thread.v1',
      thread: ref,
      part: 2,
      assetRevision: 1,
      option: 1,
      recordingGeneration: 1,
    };
    expect(LockThreadCallSchema.safeParse(lock).success).toBe(true);
    for (const patch of [
      { option: 3 },
      { part: 0 },
      { assetRevision: 0 },
      { recordingGeneration: 0 },
      { correct: true },
      { stopId: 'call-one' },
      { assetId: id(40) },
      { commandId: id(81) },
      { day: '2026-10-31' },
    ])
      expect(LockThreadCallSchema.safeParse({ ...lock, ...patch }).success).toBe(false);
    expect(LockThreadCallSchema.safeParse({ ...lock, recordingGeneration: undefined }).success).toBe(false);
    // The pick names the question it was made on (D-233): a lock without the revision cannot be judged against it.
    expect(LockThreadCallSchema.safeParse({ ...lock, assetRevision: undefined }).success).toBe(false);
  });

  it('answers a lock with what it did, or that recording is paused, and never a pick, a time or a result', () => {
    const answered = {
      version: 'content-thread.v1',
      scope,
      operation: 'thread.call-lock',
      recorded: true,
      thread: ref,
      part: 2,
      result: 'locked',
    };
    for (const result of ['locked', 'stands', 'closed', 'changed'])
      expect(ThreadCallLockAcceptanceSchema.safeParse({ ...answered, result }).success).toBe(true);
    expect(ThreadCallLockAcceptanceSchema.safeParse({ ...answered, result: 'wrong' }).success).toBe(false);
    for (const extra of [
      { option: 1 },
      { right: true },
      { correct: true },
      { recordedAt: '2026-10-31T13:02:00.000Z' },
      { commandId: id(81) },
      { replayed: false },
    ])
      expect(ThreadCallLockAcceptanceSchema.safeParse({ ...answered, ...extra }).success).toBe(false);
    const paused = {
      version: 'content-thread.v1',
      scope,
      operation: 'thread.call-lock',
      recorded: false,
      reason: 'recording_paused',
      currentGeneration: 2,
    };
    expect(ThreadCallLockAcceptanceSchema.safeParse(paused).success).toBe(true);
    expect(ThreadCallLockAcceptanceSchema.safeParse({ ...paused, reason: 'thread_gone' }).success).toBe(false);
    expect(ThreadCallLockAcceptanceSchema.safeParse({ ...paused, part: 2 }).success).toBe(false);
  });
});
