import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  alterationProblem,
  citationHolds as citationHoldsWith,
  flawPayload,
  planFlaw as planFlawWith,
  seedOf as seedOfWith,
  splitSentences,
  type PassageSource,
} from './flaw.js';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const planFlaw = (sources: readonly PassageSource[], seed: number, avoid?: ReadonlySet<string>) =>
  planFlawWith(sources, seed, sha, avoid);
const citationHolds = (text: string, payload: Parameters<typeof citationHoldsWith>[1]) =>
  citationHoldsWith(text, payload, sha);
const seedOf = (key: string) => seedOfWith(key, sha);

const BLOCK =
  'The Moon takes about 27 days to orbit the Earth once. It also turns once on its axis in the same time, so we always see the same face. Tides are caused mostly by the Moon pulling on the oceans. The Sun pulls too, but about half as strongly.';

const source = (blocks: PassageSource['blocks'], assetId = '0199b000-0000-7000-8000-000000000001'): PassageSource => ({
  assetId,
  assetRevision: 1,
  title: 'CI fixture title',
  summary: 'CI fixture summary.',
  blocks,
});

describe('splitSentences', () => {
  it('splits at a full stop and a capital, with offsets that cut the original text', () => {
    const sentences = splitSentences(BLOCK);
    expect(sentences.map((sentence) => sentence.text)).toEqual([
      'The Moon takes about 27 days to orbit the Earth once.',
      'It also turns once on its axis in the same time, so we always see the same face.',
      'Tides are caused mostly by the Moon pulling on the oceans.',
      'The Sun pulls too, but about half as strongly.',
    ]);
    for (const sentence of sentences) expect(BLOCK.slice(sentence.start, sentence.end)).toBe(sentence.text);
  });

  it('does not split on decimals, abbreviations or initials', () => {
    const text =
      'Light takes 8.3 minutes to reach us, e.g. from the Sun. J. R. Smith measured it first. Then others did.';
    expect(splitSentences(text).map((sentence) => sentence.text)).toEqual([
      'Light takes 8.3 minutes to reach us, e.g. from the Sun.',
      'J. R. Smith measured it first.',
      'Then others did.',
    ]);
  });

  it('keeps a closing quote with its sentence and treats text with no end as one sentence', () => {
    expect(splitSentences('She said “yes.” Then she left.').map((sentence) => sentence.text)).toEqual([
      'She said “yes.”',
      'Then she left.',
    ]);
    expect(splitSentences('no end here')).toHaveLength(1);
    expect(splitSentences('')).toEqual([]);
  });
});

describe('planFlaw', () => {
  it('chooses three or four consecutive sentences, one to alter, and keeps the Scroll’s own sentence as the key', () => {
    const plan = planFlaw([source([{ blockId: 'intro-moon', text: BLOCK }])], 7)!;
    expect(plan.sentences).toHaveLength(4);
    expect(plan.original).toBe(plan.sentences[plan.flawIndex]);
    expect(plan.source).toMatchObject({ blockId: 'intro-moon', start: 0 });
    expect(BLOCK.slice(plan.source.start, plan.source.end)).toBe(plan.sentences.join(' '));
    expect(plan.source.quoteHash).toBe(sha(plan.sentences.join(' ')));
  });

  it('prefers a sentence that states something checkable: a number, a cause or a comparison', () => {
    const block =
      'The garden sits behind the old house on the hill. A wall runs along the whole of the eastern side. Rain falls here on most evenings of the year. The shed stands quietly in the far corner.';
    const withCue = `${block} Water boils at a lower temperature on a mountain because the air pressure is lower.`;
    const plan = planFlaw([source([{ blockId: 'a-block', text: withCue }])], 3)!;
    // The window of four ends on the checkable sentence for some seeds; for every seed the choice is deterministic.
    expect(planFlaw([source([{ blockId: 'a-block', text: withCue }])], 3)).toEqual(plan);
    const cue = planFlaw(
      [
        source([
          {
            blockId: 'a-block',
            text: 'The kettle sat on the stove since breakfast. Water boils at 100 degrees at sea level. The window faced the garden. The cat slept near the fire.',
          },
        ]),
      ],
      0,
    )!;
    expect(cue.original).toBe('Water boils at 100 degrees at sea level.');
  });

  it('is the same for the same seed, and a different seed can choose another passage', () => {
    const sources = [
      source([{ blockId: 'one-block', text: BLOCK }]),
      source(
        [{ blockId: 'two-block', text: BLOCK.replace('27 days', '30 days').replace('Moon', 'moon') }],
        '0199b000-0000-7000-8000-000000000002',
      ),
    ];
    expect(planFlaw(sources, 11)).toEqual(planFlaw(sources, 11));
    const seen = new Set([0, 1, 2, 3, 4, 5].map((seed) => planFlaw(sources, seed)?.source.blockId));
    expect(seen.size).toBeGreaterThan(1);
  });

  it('passes over a Scroll used lately unless it is the only one, and makes nothing when no block has three readable sentences', () => {
    const used = '0199b000-0000-7000-8000-000000000001';
    const other = '0199b000-0000-7000-8000-000000000002';
    const sources = [
      source([{ blockId: 'one-block', text: BLOCK }], used),
      source([{ blockId: 'two-block', text: BLOCK }], other),
    ];
    for (let seed = 0; seed < 6; seed += 1)
      expect(planFlaw(sources, seed, new Set([used]))?.source.assetId).toBe(other);
    expect(planFlaw([sources[0]!], 0, new Set([used]))?.source.assetId).toBe(used);
    expect(planFlaw([source([{ blockId: 'short-block', text: 'Only one. And two.' }])], 0)).toBeUndefined();
    expect(planFlaw([], 0)).toBeUndefined();
  });
});

describe('alterationProblem: the code judges what a model proposed', () => {
  const original = 'The Moon takes about 27 days to orbit the Earth once.';

  it('accepts a one-fact change of the same kind', () => {
    expect(alterationProblem(original, 'The Moon takes about 7 days to orbit the Earth once.')).toBeUndefined();
    expect(alterationProblem(original, 'The Moon takes about 27 days to orbit the Sun once.')).toBeUndefined();
  });

  it.each([
    ['', 'empty'],
    ['The Moon takes about 27 days\nto orbit the Earth once.', 'control'],
    [original, 'same'],
    ['the moon takes about 27 DAYS to orbit the earth once', 'same'],
    ['The Moon orbits.', 'length'],
    ['The Moon takes about 7 days to orbit the Earth once. It is slow.', 'many_sentences'],
    ['The Moon takes about 7 days to orbit the Earth once', 'not_a_sentence'],
    ['The Moon takes about 7 days to orbit the Earth, see https://example.test.', 'link'],
    ['The Moon takes about 7 days to orbit the Earth, which is wrong.', 'tell'],
    ['A wholly different statement about volcanoes erupting often.', 'too_different'],
  ])('refuses %j as %s', (altered, problem) => {
    expect(alterationProblem(original, altered)).toBe(problem);
  });

  it('refuses one longer than a shown sentence can be', () => {
    const long = 'The Moon takes about 27 days to orbit the Earth once ' + 'and then '.repeat(40) + 'it does so again.';
    expect(alterationProblem(`${original} ${'x'.repeat(250)}.`, long)).toBe('too_long');
  });

  it('lets a tell word stand when the original already has it', () => {
    expect(
      alterationProblem(
        'A common myth says the Moon is made of cheese.',
        'A common myth says the Moon is made of stone.',
      ),
    ).toBeUndefined();
  });
});

describe('flawPayload and citationHolds', () => {
  const plan = planFlaw([source([{ blockId: 'intro-moon', text: BLOCK }])], 2)!;
  const altered = plan.original.replace(/\b(\d+|Moon|Sun|Tides)\b/, (word) =>
    word === 'Moon' ? 'Sun' : word === 'Sun' ? 'Moon' : word === 'Tides' ? 'Winds' : String(Number(word) + 3),
  );

  it('puts the altered sentence in the flaw’s place and keeps the original as the key', () => {
    const payload = flawPayload(plan, altered);
    expect(payload.sentences[plan.flawIndex]).toBe(altered);
    expect(payload.original).toBe(plan.original);
    expect(payload.sentences).not.toContain(plan.original);
  });

  it('holds while the block still says what it did, and fails once the Scroll is corrected', () => {
    const payload = flawPayload(plan, altered);
    expect(citationHolds(BLOCK, payload)).toBe(true);
    expect(citationHolds(BLOCK.replace('27 days', '28 days'), payload)).toBe(false);
    expect(citationHolds(BLOCK.slice(0, 30), payload)).toBe(false);
    expect(citationHolds(`Added words first. ${BLOCK}`, payload)).toBe(false);
  });

  it('is refused when the altered sentence is the original', () => {
    expect(() => flawPayload(plan, plan.original)).toThrow();
  });
});

describe('seedOf', () => {
  it('is a stable number for a key', () => {
    expect(seedOf('room:2026-11-01')).toBe(seedOf('room:2026-11-01'));
    expect(seedOf('room:2026-11-01')).not.toBe(seedOf('room:2026-11-02'));
    expect(Number.isInteger(seedOf('x'))).toBe(true);
  });
});
