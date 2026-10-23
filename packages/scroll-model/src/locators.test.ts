import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  buildBlockStateSnapshot,
  createPassageLocator,
  defaultBlockState,
  deriveAnchorMap,
  personalParamKeys,
  projectText,
  quoteHash,
  repointLocator,
  ScrollLocator,
  validateLocator,
  walkBlocks,
  type Block,
  type ScrollDocument,
  type ScrollPassageLocator,
} from './index.js';
import { arrange, make, scrollDocument, seal } from './test-support/arbitraries.js';
import { allFixtures, fixture } from './test-support/fixtures.js';

/** A document with at least one text block, and one of its text blocks with a valid range. */
const passageCase = fc
  .oneof(scrollDocument(), fc.constantFrom(...allFixtures().map((item) => item.document)))
  .chain((document) => {
    const texts = [...walkBlocks(document.sections)].flatMap((visit) => {
      const text = projectText(visit.block);
      return text === null || text.length < 2 ? [] : [{ blockId: visit.block.id, text }];
    });
    if (texts.length === 0) return fc.constant(null);
    return fc
      .constantFrom(...texts)
      .chain(({ blockId, text }) =>
        fc
          .tuple(fc.nat({ max: text.length - 1 }), fc.integer({ min: 1, max: 600 }))
          .map(([start, length]) => ({ document, blockId, text, start, end: Math.min(text.length, start + length) })),
      );
  })
  .filter((value): value is NonNullable<typeof value> => value !== null);

const isLowSurrogate = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;

describe('scroll_passage locators', () => {
  it('validate when created from a selection that does not split a character, and quote exactly that text', () => {
    fc.assert(
      fc.property(passageCase, ({ document, blockId, text, start, end }) => {
        const splits =
          isLowSurrogate(text.charCodeAt(start)) || (end < text.length && isLowSurrogate(text.charCodeAt(end)));
        const created = createPassageLocator(document, blockId, start, end);
        if (splits) {
          expect(created).toEqual({ kind: 'invalid', reason: 'range-splits-character' });
          return;
        }
        expect(created.kind).toBe('locator');
        if (created.kind !== 'locator') return;
        expect(ScrollLocator.safeParse(created.locator).success).toBe(true);
        const validated = validateLocator(document, created.locator);
        expect(validated).toMatchObject({ kind: 'valid', quote: text.slice(start, end) });
        expect(created.locator.quoteHash).toBe(quoteHash(text.slice(start, end)));
      }),
      { numRuns: 120 },
    );
  });

  it('refuse a locator whose hash, range, revision or asset does not match', () => {
    fc.assert(
      fc.property(passageCase, fc.integer({ min: 1, max: 50 }), ({ document, blockId, start, end }, shift) => {
        const created = createPassageLocator(document, blockId, start, end);
        if (created.kind !== 'locator') return;
        const locator = created.locator;
        const reason = (changed: ScrollPassageLocator) => {
          const outcome = validateLocator(document, changed);
          return outcome.kind === 'invalid' ? outcome.reason : null;
        };
        expect(reason({ ...locator, quoteHash: quoteHash(`${String(shift)}x`) })).toBe('quote-hash-mismatch');
        expect(reason({ ...locator, revision: locator.revision + shift })).toBe('revision-mismatch');
        expect(reason({ ...locator, assetId: `${locator.assetId}-other` })).toBe('asset-mismatch');
        expect(reason({ ...locator, blockId: 'no-such-block' })).toBe('block-not-found');
        expect(reason({ ...locator, end: locator.start })).toBe('range-invalid');
        expect(reason({ ...locator, end: 100_000 })).toBe('range-invalid');
      }),
      { numRuns: 80 },
    );
  });

  it('only point into text blocks', () => {
    const document = fixture('attention-slowly').document;
    expect(createPassageLocator(document, 'it-diagram', 0, 3)).toEqual({ kind: 'invalid', reason: 'block-not-text' });
  });
});

describe('scroll_block locators', () => {
  const tides = fixture('spring-neap-tides').document;
  const weight = fixture('weight-other-worlds').document;
  const base = (document: ScrollDocument, blockId: string, blockType: string) => ({
    kind: 'scroll_block' as const,
    assetId: document.assetId,
    revision: document.revision,
    blockId,
    blockType,
    blockVersion: 1,
  });

  it('validate type and version, and a state that fits the block', () => {
    expect(validateLocator(tides, base(tides, 'range-sim', 'simulation')).kind).toBe('valid');
    expect(validateLocator(tides, { ...base(tides, 'range-sim', 'chart') })).toEqual({
      kind: 'invalid',
      reason: 'block-type-mismatch',
    });
    expect(validateLocator(tides, { ...base(tides, 'range-sim', 'simulation'), blockVersion: 2 })).toEqual({
      kind: 'invalid',
      reason: 'block-version-mismatch',
    });
    const withState = (params: Record<string, number>) => ({
      ...base(tides, 'range-sim', 'simulation'),
      state: { state: { type: 'simulation' as const, params }, personalIncluded: false },
    });
    expect(validateLocator(tides, withState({ sunShare: 0.9 })).kind).toBe('valid');
    expect(validateLocator(tides, withState({ sunShare: 0.91 }))).toEqual({ kind: 'invalid', reason: 'state-invalid' });
    expect(validateLocator(tides, withState({ moonShare: 0.5 }))).toEqual({ kind: 'invalid', reason: 'state-invalid' });
    const frame = {
      ...base(tides, 'align-diagram', 'diagram'),
      state: { state: { type: 'diagram' as const, frame: 'neap' }, personalIncluded: false },
    };
    expect(validateLocator(tides, frame).kind).toBe('valid');
    expect(validateLocator(tides, { ...base(tides, 'pulls-p1', 'paragraph'), state: frame.state })).toEqual({
      kind: 'invalid',
      reason: 'state-not-allowed',
    });
  });

  it('accept a personal value only when the snapshot says so and the sender confirmed it', () => {
    const snapshot = (personalIncluded: boolean, params: Record<string, number>) => ({
      ...base(weight, 'weight-sim', 'simulation'),
      state: { state: { type: 'simulation' as const, params }, personalIncluded },
    });
    expect(validateLocator(weight, snapshot(false, {})).kind).toBe('valid');
    expect(validateLocator(weight, snapshot(true, { weightKg: 72 }))).toEqual({
      kind: 'invalid',
      reason: 'personal-not-confirmed',
    });
    expect(validateLocator(weight, snapshot(true, { weightKg: 72 }), { personalConsent: true }).kind).toBe('valid');
    expect(validateLocator(weight, snapshot(false, { weightKg: 72 }), { personalConsent: true })).toEqual({
      kind: 'invalid',
      reason: 'personal-flag-mismatch',
    });
    expect(validateLocator(weight, snapshot(true, {}), { personalConsent: true })).toEqual({
      kind: 'invalid',
      reason: 'personal-flag-mismatch',
    });
  });
});

describe('anchor maps across revisions', () => {
  const previous = fixture('attention-slowly').document;
  /** Revision 2: one paragraph reworded, the chart removed, the table's caption changed. */
  const next: ScrollDocument = (() => {
    const sections = structuredClone(previous.sections).map((section) => ({
      ...section,
      blocks: section.blocks
        .filter((block) => block.id !== 'grid-chart')
        .map((block) => {
          if (block.id === 'squared-p1' && block.type === 'paragraph') {
            return {
              ...block,
              data: {
                spans: [
                  {
                    text: 'Six words make thirty-six comparisons. Twelve words means 144. Double it and the work quadruples.',
                  },
                ],
              },
            };
          }
          if (block.id === 'it-table' && block.type === 'table')
            return { ...block, data: { ...block.data, caption: 'Where “it” looks, word by word' } };
          return block;
        }),
    }));
    return seal(sections, { ...previous, revision: 2 });
  })();

  it('lists every block of the previous revision with an explicit change', () => {
    const outcome = deriveAnchorMap(previous, next);
    if (outcome.kind !== 'derived') throw new Error(outcome.reason);
    const changes = Object.fromEntries(outcome.map.entries.map((entry) => [entry.from, entry.change]));
    expect(outcome.map.entries).toHaveLength([...walkBlocks(previous.sections)].length);
    expect(changes).toMatchObject({
      'crowd-p1': 'same',
      'squared-p1': 'text-changed',
      'grid-chart': 'removed',
      'it-table': 'updated',
    });
    expect(outcome.map.entries.find((entry) => entry.from === 'grid-chart')?.to).toBeNull();
  });

  it('re-points passages only by finding their exact quote, and says so otherwise', () => {
    const outcome = deriveAnchorMap(previous, next);
    if (outcome.kind !== 'derived') throw new Error(outcome.reason);
    const passage = (blockId: string, quote: string) => {
      const text =
        projectText(
          [...walkBlocks(previous.sections)].find((visit) => visit.block.id === blockId)?.block ??
            make('subheading', { text: 'x' }),
        ) ?? '';
      const start = text.indexOf(quote);
      const created = createPassageLocator(previous, blockId, start, start + quote.length);
      if (created.kind !== 'locator') throw new Error(created.reason);
      return created.locator;
    };
    expect(repointLocator(passage('crowd-p1', 'Read this'), previous, next, outcome.map)).toMatchObject({
      kind: 'same',
      change: 'same',
      locator: { revision: 2, blockId: 'crowd-p1' },
    });
    const moved = repointLocator(passage('squared-p1', 'Twelve words means 144.'), previous, next, outcome.map);
    expect(moved).toMatchObject({
      kind: 'remapped',
      change: 'text-changed',
      locator: { revision: 2, blockId: 'squared-p1' },
    });
    if (moved.kind === 'remapped' && moved.locator.kind === 'scroll_passage') {
      expect(validateLocator(next, moved.locator)).toMatchObject({ kind: 'valid', quote: 'Twelve words means 144.' });
    }
    expect(repointLocator(passage('squared-p1', 'six × six comparisons'), previous, next, outcome.map)).toEqual({
      kind: 'unavailable',
      reason: 'passage-changed',
      sectionId: 'why-squared',
    });
    const chart = {
      kind: 'scroll_block' as const,
      assetId: previous.assetId,
      revision: 1,
      blockId: 'grid-chart',
      blockType: 'chart',
      blockVersion: 1,
    };
    expect(repointLocator(chart, previous, next, outcome.map)).toEqual({
      kind: 'unavailable',
      reason: 'block-removed',
      sectionId: 'why-squared',
    });
  });

  it('never re-points silently: removals, rewrites and flipped personal flags are all reported', () => {
    const edit = fc.record({
      removals: fc.array(fc.nat(), { maxLength: 4 }),
      rewrites: fc.array(fc.nat(), { maxLength: 4 }),
      flips: fc.array(fc.nat(), { maxLength: 4 }),
    });
    fc.assert(
      fc.property(scrollDocument(3, 5), edit, (document, { removals, rewrites, flips }) => {
        const ids = document.sections.flatMap((section) => section.blocks.map((block) => block.id));
        const pick = (picks: number[]) => new Set(picks.map((n) => ids[n % ids.length]));
        const drop = pick(removals);
        const rewrite = pick(rewrites);
        const flip = pick(flips);
        const edited = (block: Block): Block => {
          if (rewrite.has(block.id) && block.type === 'paragraph') {
            return { ...block, data: { spans: [{ text: 'A rewritten paragraph says something else now.' }] } };
          }
          if (flip.has(block.id) && block.type === 'simulation') {
            const params = block.data.params.map((param, index) =>
              index === 0
                ? param.personal === true
                  ? (({ personal: _off, ...rest }) => rest)(param)
                  : { ...param, personal: true as const }
                : param,
            );
            return { ...block, data: { ...block.data, params } };
          }
          return block;
        };
        const sections = document.sections
          .map((section) => ({ ...section, blocks: section.blocks.filter((block) => !drop.has(block.id)).map(edited) }))
          .filter((section) => section.blocks.length > 0)
          .map((section, index) =>
            index === 0
              ? { ...section, heading: null }
              : section.heading === null
                ? { ...section, heading: 'Next' }
                : section,
          );
        if (sections.length === 0) return;
        const revised = seal(sections, { ...document, revision: 2 });
        const derived = deriveAnchorMap(document, revised);
        if (derived.kind !== 'derived') throw new Error(derived.reason);
        for (const { block } of walkBlocks(document.sections)) {
          const state = defaultBlockState(block);
          const locator = {
            kind: 'scroll_block' as const,
            assetId: document.assetId,
            revision: 1,
            blockId: block.id,
            blockType: block.type,
            blockVersion: 1,
            ...(state === null ? {} : { state: { state, personalIncluded: personalParamKeys(block).length > 0 } }),
          };
          const outcome = repointLocator(locator, document, revised, derived.map);
          const entry = derived.map.entries.find((candidate) => candidate.from === block.id);
          expect(['same', 'remapped', 'state-reset', 'unavailable']).toContain(outcome.kind);
          if (outcome.kind === 'same') expect(entry?.change).toBe('same');
          if (outcome.kind === 'same' || outcome.kind === 'remapped' || outcome.kind === 'state-reset') {
            expect(validateLocator(revised, outcome.locator, { personalConsent: true }).kind).toBe('valid');
          }
          if (drop.has(block.id)) expect(outcome.kind).toBe('unavailable');
          if (rewrite.has(block.id) && block.type === 'paragraph' && !drop.has(block.id))
            expect(outcome.kind).not.toBe('same');
          if (flip.has(block.id) && block.type === 'simulation' && !drop.has(block.id))
            expect(outcome.kind).toBe('state-reset');
        }
      }),
      { numRuns: 50 },
    );
  });

  it('reports a rewritten paragraph and a flipped personal flag (both directions), never as same', () => {
    const rev1 = fixture('weight-other-worlds').document;
    const reseal = (document: ScrollDocument, revision: number) => seal(document.sections, { ...document, revision });
    const rewritten = structuredClone(rev1);
    const paragraph = rewritten.sections[0]?.blocks.find((block) => block.id === 'scales-p1');
    if (paragraph?.type !== 'paragraph') throw new Error('fixture changed');
    paragraph.data = { spans: [{ text: 'An entirely different claim now lives under this id.' }] };
    const rev2 = reseal(rewritten, 2);
    const map2 = deriveAnchorMap(rev1, rev2);
    if (map2.kind !== 'derived') throw new Error(map2.reason);
    const paragraphLocator = {
      kind: 'scroll_block' as const,
      assetId: rev1.assetId,
      revision: 1,
      blockId: 'scales-p1',
      blockType: 'paragraph',
      blockVersion: 1,
    };
    expect(repointLocator(paragraphLocator, rev1, rev2, map2.map)).toMatchObject({
      kind: 'remapped',
      change: 'text-changed',
      moved: false,
    });

    const sim = rev1.sections[0]?.blocks[0];
    if (sim?.type !== 'simulation') throw new Error('fixture changed');
    const consented = buildBlockStateSnapshot(
      sim,
      { type: 'simulation', params: { weightKg: 80 } },
      { includePersonal: true },
    );
    if (consented.kind !== 'snapshot') throw new Error(consented.kind);
    const simLocator = {
      kind: 'scroll_block' as const,
      assetId: rev1.assetId,
      revision: 1,
      blockId: sim.id,
      blockType: 'simulation',
      blockVersion: 1,
      state: consented.snapshot,
    };
    // weightKg stops being personal.
    const notPersonal = structuredClone(rev1);
    const first = notPersonal.sections[0]?.blocks[0];
    if (first?.type !== 'simulation') throw new Error('fixture changed');
    first.data.params = first.data.params.map(({ personal: _personal, ...param }) => param);
    const rev3 = reseal(notPersonal, 3);
    const map3 = deriveAnchorMap(rev1, rev3);
    if (map3.kind !== 'derived') throw new Error(map3.reason);
    expect(map3.map.entries.find((entry) => entry.from === sim.id)?.change).toBe('state-changed');
    const stopped = repointLocator(simLocator, rev1, rev3, map3.map);
    expect(stopped).toMatchObject({ kind: 'state-reset', change: 'state-changed' });
    if (stopped.kind === 'state-reset') expect(stopped.locator.state).toBeUndefined();
    // weightKg becomes personal again: a snapshot shared without personal values must not now carry one.
    const plain = buildBlockStateSnapshot(first, { type: 'simulation', params: { weightKg: 80 } });
    if (plain.kind !== 'snapshot') throw new Error(plain.kind);
    expect(plain.snapshot).toEqual({
      state: { type: 'simulation', params: { weightKg: 80 } },
      personalIncluded: false,
    });
    const plainLocator = { ...simLocator, revision: 3, state: plain.snapshot };
    const map4 = deriveAnchorMap(rev3, reseal(rev1, 4));
    if (map4.kind !== 'derived') throw new Error(map4.reason);
    expect(repointLocator(plainLocator, rev3, reseal(rev1, 4), map4.map)).toMatchObject({
      kind: 'state-reset',
      change: 'state-changed',
    });
  });

  it('refuses maps that do not belong to the two revisions, and conflicting moves', () => {
    const outcome = deriveAnchorMap(previous, next);
    if (outcome.kind !== 'derived') throw new Error(outcome.reason);
    const locator = {
      kind: 'scroll_block' as const,
      assetId: previous.assetId,
      revision: 1,
      blockId: 'crowd-p1',
      blockType: 'paragraph',
      blockVersion: 1,
    };
    expect(repointLocator(locator, previous, next, { ...outcome.map, toRevision: 3 })).toEqual({
      kind: 'invalid',
      reason: 'map-mismatch',
    });
    expect(deriveAnchorMap(next, previous)).toEqual({ kind: 'invalid', reason: 'revision-order' });
    expect(deriveAnchorMap(previous, next, { moves: [{ from: 'crowd-p2', to: 'crowd-p1' }] })).toEqual({
      kind: 'invalid',
      reason: 'move-conflict',
    });
    expect(deriveAnchorMap(previous, next, { moves: [{ from: 'nothing', to: 'crowd-p1' }] })).toEqual({
      kind: 'invalid',
      reason: 'move-unknown-source',
    });
    const single = seal(
      arrange([{ heading: 'only', blocks: [make('paragraph', { spans: [{ text: 'Alone here.' }] })] }]),
    );
    expect(deriveAnchorMap(single, { ...previous, revision: 2 })).toEqual({
      kind: 'invalid',
      reason: 'asset-mismatch',
    });
  });
});
