import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { stopWords, validateDocumentV2, WORDS_PER_MINUTE_V2, type ScrollDocumentV2 } from '@knowscroll/scroll-model';
import { evidencePassages } from '../production/evidence.js';
import { fixtureAuthoredV2, fixtureResearchPageV2 } from '../production/spike-v2/writer-v2.fixture.js';
import { compileGeneratedScrollV2, publicationV2 } from '../production/writer-v2.js';
import { MIN_STOP_VISIBLE_MS, minVisibleMsOf, readingFactsOfV2, STOP_READ_SHARE } from './reading-facts-v2.js';
import { ReadingFactsSchema } from './reading-facts-schema.js';

const compiled = compileGeneratedScrollV2(fixtureAuthoredV2(), {
  publication: publicationV2('seasons'),
  recipe: {
    variant: 'stage',
    misconception: {
      kind: 'myth',
      claim: 'Orrin is warmest because it is closest to its star.',
      source: { label: 'CI fixture label', reviewed: true },
    },
  },
  passages: evidencePassages([fixtureResearchPageV2]),
  pages: [fixtureResearchPageV2],
});
if (compiled.kind !== 'compiled') throw new Error('CI fixture must compile');
const document = compiled.document;

describe('reading facts v3 of the labelled Orrin fixture', () => {
  const facts = readingFactsOfV2(document);

  it('makes every stop and call a unit, but only read stops weigh: playing never stands in for reading', () => {
    expect(facts.v).toBe(3);
    expect(facts.blocks.map((block) => block.id)).toEqual(document.stops.map((stop) => stop.id));
    const measured = new Map(document.measures.stops.map((stop) => [stop.stopId, stop.weight]));
    for (const [index, stop] of document.stops.entries())
      expect(facts.blocks[index]?.weight).toBe(stop.kind === 'read' ? measured.get(stop.id) : 0);
    expect(facts.blocks.some((block) => block.type !== 'stop' && block.weight > 0)).toBe(false);
    expect(facts.totalWeight).toBe(
      document.stops.reduce((total, stop) => total + (stop.kind === 'read' ? (measured.get(stop.id) ?? 0) : 0), 0),
    );
    expect(facts.totalWeight).toBeGreaterThan(0);
    expect(facts.nested).toEqual([]);
    // The ten seconds a call takes stay in the estimate, so honest play does not look like under-reading.
    expect(facts.estimatedReadingMs).toBe(document.measures.readingSeconds * 1000);
  });

  it('counts a read stop after a share of its own reading time, and a call only when locked or revealed', () => {
    for (const [index, stop] of document.stops.entries()) {
      const rule = facts.blocks[index]?.seen;
      if (stop.kind === 'read') {
        const nominalMs = (stopWords(stop) * 60_000) / WORDS_PER_MINUTE_V2;
        expect(rule).toEqual({ kind: 'visible', minVisibleMs: minVisibleMsOf(stop) });
        expect(minVisibleMsOf(stop)).toBe(Math.max(MIN_STOP_VISIBLE_MS, Math.round(nominalMs * STOP_READ_SHARE)));
      } else expect(rule).toEqual({ kind: 'interaction', interactions: ['locked', 'revealed'] });
    }
  });

  it('is what the stored shape accepts, and refuses a v3 shape that nests or lacks a rule', () => {
    expect(ReadingFactsSchema.parse(facts)).toEqual(facts);
    expect(ReadingFactsSchema.safeParse({ ...facts, nested: [{ id: 'a', owner: 'b', type: 'stop' }] }).success).toBe(
      false,
    );
    const { seen: _seen, ...bare } = facts.blocks[0]!;
    expect(ReadingFactsSchema.safeParse({ ...facts, blocks: [bare] }).success).toBe(false);
  });
});

describe('reading facts of a Scroll with play blocks (labelled CI fixtures, D-063, D-209)', () => {
  const blocksFixture = (name: string): ScrollDocumentV2 => {
    const raw = JSON.parse(
      readFileSync(new URL(`../../../../../scroll-model/fixtures/documents/${name}-ci.json`, import.meta.url), 'utf8'),
    ) as unknown;
    const checked = validateDocumentV2(raw, { verify: false });
    if (checked.kind !== 'valid') throw new Error('CI expected a valid fixture');
    return checked.document;
  };

  it.each(['sort-fork-blocks', 'scale-chart-blocks'])(
    'counts a stop with a block by being read, like any stop: no interaction of a block is accepted, so nothing it records can reach evidence (%s)',
    (name) => {
      const withBlocks = blocksFixture(name);
      const facts = readingFactsOfV2(withBlocks);
      expect(withBlocks.stops.some((stop) => stop.kind === 'read' && stop.interactive !== undefined)).toBe(true);
      for (const [index, stop] of withBlocks.stops.entries()) {
        const rule = facts.blocks[index]?.seen;
        if (stop.kind !== 'read') continue;
        expect(rule).toEqual({ kind: 'visible', minVisibleMs: minVisibleMsOf(stop) });
        expect(facts.blocks[index]?.type).toBe('stop');
      }
      // The only interactions evidence accepts are those of calls, and only by kind.
      const accepted = facts.blocks.flatMap((block) =>
        block.seen.kind === 'interaction' ? block.seen.interactions : [],
      );
      expect(new Set(accepted)).toEqual(new Set(['locked', 'revealed']));
      expect(new Set(facts.blocks.map((block) => block.type))).toEqual(new Set(['stop', 'call_it', 'final_call']));
    },
  );

  it('asks a stop with a block for the time its words, the block’s included, take to read', () => {
    const withBlocks = blocksFixture('sort-fork-blocks');
    const chain = withBlocks.stops.find((stop) => stop.id === 'chain');
    if (chain?.kind !== 'read' || chain.interactive === undefined) throw new Error('CI expected the sort stop');
    const own = chain.blocks.reduce((total, block) => total + block.text.split(/\s+/u).length, 0);
    expect(stopWords(chain)).toBeGreaterThan(own);
  });
});
