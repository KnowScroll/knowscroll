import { describe, expect, it } from 'vitest';
import {
  FEED_RULES,
  findTitle,
  noteProblem,
  pickFind,
  repliesShownTo,
  residentToPost,
  routeFeed,
  slotOf,
  type FeedFacts,
  type FindCandidate,
} from './feed.js';

const HOUR = 3_600_000;
const NOW = new Date('2026-11-01T09:07:00.000Z');
const ago = (hours: number) => new Date(NOW.getTime() - hours * HOUR);

const find = (n: number): FindCandidate => ({
  assetId: `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`,
  assetRevision: 1,
  kind: n % 2 === 0 ? 'reel' : 'scroll',
  title: `Find ${String(n)}`,
  summary: 'A summary.',
});
const CAPS = { roomPerHour: 8, roomPerDay: 40 };

const facts = (over: Partial<FeedFacts> = {}): FeedFacts => ({
  now: NOW,
  room: { open: true, cast: ['explainer', 'skeptic'], listeners: 2 },
  candidate: find(1),
  lastFindAt: {},
  counts: { roomLastHour: 0, roomToday: 0, feedToday: 0 },
  ...over,
});

describe('choosing a find (code, never the model)', () => {
  it('takes the newest asset the room has not seen', () => {
    const candidates = [find(3), find(2), find(1)];
    expect(pickFind(candidates, new Set())?.assetId).toBe(find(3).assetId);
    expect(pickFind(candidates, new Set([find(3).assetId]))?.assetId).toBe(find(2).assetId);
    expect(pickFind(candidates, new Set([find(3).assetId, find(2).assetId]))?.assetId).toBe(find(1).assetId);
  });

  it('finds nothing when the library holds nothing new: the feed runs dry instead of repeating', () => {
    const candidates = [find(2), find(1)];
    expect(pickFind(candidates, new Set(candidates.map((candidate) => candidate.assetId)))).toBeUndefined();
    expect(pickFind([], new Set())).toBeUndefined();
  });
});

describe('who posts', () => {
  it('lets a resident whose rest is over post, the one who posted longest ago first', () => {
    expect(residentToPost(['explainer', 'skeptic'], {}, NOW)).toBe('explainer');
    expect(residentToPost(['explainer', 'skeptic'], { explainer: ago(7) }, NOW)).toBe('skeptic');
    expect(residentToPost(['explainer', 'skeptic'], { explainer: ago(7), skeptic: ago(9) }, NOW)).toBe('skeptic');
    expect(residentToPost(['explainer', 'skeptic'], { explainer: ago(9), skeptic: ago(7) }, NOW)).toBe('explainer');
  });

  it('keeps a resident resting for six hours: one find per resident per room', () => {
    expect(residentToPost(['explainer'], { explainer: ago(5.99) }, NOW)).toBeUndefined();
    expect(residentToPost(['explainer'], { explainer: ago(6) }, NOW)).toBe('explainer');
    expect(FEED_RULES.residentRestMs).toBe(6 * HOUR);
  });
});

describe('a look at a room (D-248): zero calls unless a find is posted', () => {
  it('posts when a resident may and there is something new', () => {
    expect(routeFeed(facts(), CAPS)).toMatchObject({ kind: 'post', inhabitant: 'explainer' });
  });

  it('lets go, recording nothing, when the room is closed, has no resident, or nobody listens', () => {
    expect(routeFeed(facts({ room: { open: false, cast: ['explainer'], listeners: 2 } }), CAPS)).toEqual({
      kind: 'drop',
      reason: 'room_closed',
    });
    expect(routeFeed(facts({ room: { open: true, cast: [], listeners: 2 } }), CAPS)).toEqual({
      kind: 'drop',
      reason: 'no_resident',
    });
    expect(routeFeed(facts({ room: { open: true, cast: ['explainer'], listeners: 0 } }), CAPS)).toEqual({
      kind: 'drop',
      reason: 'nobody_listening',
    });
  });

  it('lets go when nothing is new, whatever else holds', () => {
    expect(routeFeed(facts({ candidate: undefined }), CAPS)).toEqual({ kind: 'drop', reason: 'nothing_new' });
  });

  it('lets go while every resident is resting', () => {
    expect(routeFeed(facts({ lastFindAt: { explainer: ago(1), skeptic: ago(2) } }), CAPS)).toEqual({
      kind: 'drop',
      reason: 'resting',
    });
  });

  it('refuses quietly, naming the cap, once the room has had three finds today', () => {
    const decision = routeFeed(facts({ counts: { roomLastHour: 0, roomToday: 3, feedToday: 3 } }), CAPS);
    expect(decision).toMatchObject({ kind: 'refuse', cap: 'feed_day' });
    expect(routeFeed(facts({ counts: { roomLastHour: 0, roomToday: 2, feedToday: 2 } }), CAPS).kind).toBe('post');
  });

  it('counts a find against the room’s own unprompted caps too', () => {
    expect(routeFeed(facts({ counts: { roomLastHour: 8, roomToday: 8, feedToday: 0 } }), CAPS)).toMatchObject({
      kind: 'refuse',
      cap: 'room_hour',
    });
    expect(routeFeed(facts({ counts: { roomLastHour: 0, roomToday: 40, feedToday: 0 } }), CAPS)).toMatchObject({
      kind: 'refuse',
      cap: 'room_day',
    });
  });

  it('is decided by the cap the feed names first when several are broken', () => {
    expect(routeFeed(facts({ counts: { roomLastHour: 9, roomToday: 41, feedToday: 3 } }), CAPS)).toMatchObject({
      cap: 'feed_day',
    });
  });
});

describe('the heartbeat', () => {
  it('looks once in each 8-hour UTC slot, three times a day', () => {
    expect(slotOf(new Date('2026-11-01T00:00:00.000Z'))).toBe('2026-11-01T00:00:00.000Z');
    expect(slotOf(new Date('2026-11-01T07:59:59.999Z'))).toBe('2026-11-01T00:00:00.000Z');
    expect(slotOf(new Date('2026-11-01T08:00:00.000Z'))).toBe('2026-11-01T08:00:00.000Z');
    expect(slotOf(new Date('2026-11-01T17:07:00.000Z'))).toBe('2026-11-01T16:00:00.000Z');
    expect(FEED_RULES.postsPerDay).toBe((24 * HOUR) / FEED_RULES.slotMs);
  });
});

describe('a title for a find', () => {
  it('is the asset’s own title, cut with an ellipsis when it would not fit', () => {
    expect(findTitle('  Why the   Moon makes tides ')).toBe('Why the Moon makes tides');
    const cut = findTitle('x'.repeat(200));
    expect([...cut]).toHaveLength(FEED_RULES.titleMaxChars);
    expect(cut.endsWith('…')).toBe(true);
  });
});

describe('the voice of a note: no claimed experience (T3 sample, D-248)', () => {
  it('passes an editorial voice', () => {
    for (const note of [
      'Worth a look: at 0:40 the bent arc is the far galaxy, stretched by the cluster in front of it.',
      'A short Scroll on why a Type I supernova leaves no hydrogen lines. Check what "standard candle" claims.',
      'A clear picture of how the arc forms, with the cluster’s mass shown as a lens.',
    ])
      expect(noteProblem(note), note).toBeUndefined();
  });

  it('rejects the claims the design drew ("changed how I picture…")', () => {
    expect(noteProblem('At 0:40 the arc changed how I picture dark matter.')).toBe('first_person');
    expect(noteProblem('I remember when this was a mystery.')).toBe('first_person');
    expect(noteProblem('It changed how people picture dark matter, truly.')).toBe('claims_experience');
    expect(noteProblem('Remembered this one from long ago.')).toBe('claims_experience');
    expect(noteProblem('A certain album has a lot to answer for.')).toBe('claims_experience');
  });

  it('rejects first person in every form, but not a Roman numeral', () => {
    for (const note of [
      "I'm sure it holds up.",
      "I've watched it twice.",
      'It stayed with me.',
      'My favourite part is the arc.',
    ])
      expect(noteProblem(note), note).toBe('first_person');
    expect(noteProblem('Type I and Type II differ in how they end.')).toBeUndefined();
    expect(noteProblem('World War I changed the maps.')).toBeUndefined();
  });

  it('rejects claims of having watched, read or lived it', () => {
    for (const note of [
      'We watched this together and loved it.',
      'Perfect for a rewatch on a rainy day.',
      'Growing up, this was the best thing on.',
      'This blew your mind and ours.',
    ])
      expect(noteProblem(note), note).toBe('claims_experience');
  });

  it('keeps the contribution rules: short, no link, no claim to be a person', () => {
    expect(noteProblem('')).toBe('empty');
    expect(noteProblem('x'.repeat(FEED_RULES.noteMaxChars + 1))).toBe('too_long');
    expect(noteProblem('See https://example.org for more.')).toBe('has_link');
    expect(noteProblem('As a student of optics, this is neat.')).toBe('claims_to_be_a_person');
  });
});

describe('the replies a reader is told of (D-299)', () => {
  const groups = [
    { signer: 'kenji', ownVoice: false, count: 2 },
    { signer: null, ownVoice: false, count: 1 },
    { signer: null, ownVoice: true, count: 1 },
    { signer: 'lena', ownVoice: true, count: 3 },
  ];
  it('counts every reply for a reader who blocked nobody and listens to residents', () => {
    expect(repliesShownTo(groups, { aiOff: false, blocked: new Set() })).toBe(7);
  });
  it('leaves out what an Off reader is told nothing of, but keeps an answer someone asked a resident for', () => {
    expect(repliesShownTo(groups, { aiOff: true, blocked: new Set() })).toBe(3);
  });
  it('leaves out a blocked person’s replies and a blocked member’s scout', () => {
    expect(repliesShownTo(groups, { aiOff: false, blocked: new Set(['kenji', 'lena']) })).toBe(2);
  });
});
