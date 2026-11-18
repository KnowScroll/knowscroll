import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OfferCoverSchema } from '@knowscroll/contracts';
import { firstFrameOf, type ScrollDocumentV2 } from '@knowscroll/scroll-model';
import { coverOfDocument } from './offer-cover.js';

/** scroll-model's labelled CI fixtures: a Scroll v1, a v2 with a stage, a v2 without one. Not product content. */
const documents = (name: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(new URL(`../../../../../scroll-model/fixtures/documents/${name}.json`, import.meta.url), 'utf8'),
  ) as Record<string, unknown>;

const v1 = documents('attention-slowly');
const withStage = documents('seasons-stage-ci') as unknown as ScrollDocumentV2;
const withoutStage = documents('scale-chart-blocks-ci') as unknown as ScrollDocumentV2;

describe('the cover of a stored Scroll document', () => {
  it('is the kicker and reading minutes alone for a Scroll v1', () => {
    expect(coverOfDocument(v1)).toEqual({ version: 'offer-cover.v1', kicker: 'Machine learning', readingMinutes: 2 });
  });

  it('adds the read stops and the first stage frame for a v2 Scroll with a stage', () => {
    const cover = coverOfDocument(withStage);
    const reads = withStage.stops.filter((stop) => stop.kind === 'read').length;
    // The fixture also has Call it and Final call stops, which are not paragraphs to read.
    expect(reads).toBeLessThan(withStage.stops.length);
    expect(cover).toEqual({
      version: 'offer-cover.v1',
      kicker: withStage.kicker,
      readingMinutes: withStage.measures.readingMinutes,
      readStops: reads,
      figure: firstFrameOf(withStage),
    });
    expect(cover?.figure).toMatchObject({ kit: 'earth-sky.v1', state: withStage.stage?.states[0]?.state });
    expect(OfferCoverSchema.safeParse(cover).success).toBe(true);
  });

  it('has no figure for a v2 Scroll without a stage, but still its read stops', () => {
    const cover = coverOfDocument(withoutStage);
    expect(cover).toMatchObject({
      kicker: withoutStage.kicker,
      readingMinutes: withoutStage.measures.readingMinutes,
      readStops: withoutStage.stops.filter((stop) => stop.kind === 'read').length,
    });
    expect(cover).not.toHaveProperty('figure');
  });

  it.each([
    ['a Reel document', { schemaVersion: 'reel-document.v1', title: 'Fixture Reel', durationMs: 30_000 }],
    ['an object without a kicker', { ...v1, kicker: undefined }],
    ['an object without measures', { ...v1, measures: undefined }],
    ['a null', null],
    ['an array', [v1]],
    ['a string', 'scroll'],
  ])('is nothing for %s', (_name, document) => {
    expect(coverOfDocument(document)).toBeUndefined();
  });

  it('is nothing, and never a throw, when a stored value does not fit the wire schema', () => {
    const long = { ...v1, kicker: 'k'.repeat(41) };
    expect(() => coverOfDocument(long)).not.toThrow();
    expect(coverOfDocument(long)).toBeUndefined();
    expect(
      coverOfDocument({ ...v1, measures: { ...(v1['measures'] as object), readingMinutes: 'soon' } }),
    ).toBeUndefined();
    expect(
      coverOfDocument({ ...withStage, stage: { kit: 'earth-sky.v1', states: [{ state: {}, alt: 'x' }] } }),
    ).toBeUndefined();
  });
});
