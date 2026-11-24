import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canRenderScroll, isScrollDocumentV3 } from './render-scroll.js';

/** scroll-model's labelled CI fixtures: a Scroll v1, a v2 with a stage and a document v3. Not product content. */
const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(new URL(`../../../../../scroll-model/fixtures/documents/${name}.json`, import.meta.url), 'utf8'),
  );

const v1 = fixture('attention-slowly');
const v2 = fixture('seasons-stage-ci');
const v3 = fixture('seasons-v3-ci');

/** Every v1 block the fixtures use, plus the named schemas: what a client that can draw them declares. */
const declaring = (...schemas: string[]) => ({
  documentSchemas: schemas,
  blocks: Object.fromEntries(
    ['fallback', 'paragraph', 'subheading', 'list', 'quote', 'callout', 'disclosure', 'diagram', 'figure'].map(
      (type) => [type, [1]],
    ),
  ),
});

describe('whether a client can be given a stored Scroll document', () => {
  it('serves a document v3 only to a client that declares scroll-document.v3', () => {
    expect(canRenderScroll(v3, declaring('scroll-document.v1', 'scroll-document.v3'))).toBe(true);
    expect(canRenderScroll(v3, declaring('scroll-document.v1'))).toBe(false);
    expect(canRenderScroll(v3, declaring('scroll-document.v1', 'scroll-document.v2'))).toBe(false);
  });

  it('still serves a v2 only to a client that declares scroll-document.v2, and a v1 to a client with the baseline', () => {
    expect(canRenderScroll(v2, declaring('scroll-document.v2'))).toBe(true);
    expect(canRenderScroll(v2, declaring('scroll-document.v1', 'scroll-document.v3'))).toBe(false);
    expect(canRenderScroll(v1, declaring('scroll-document.v1'))).toBe(true);
  });

  it('is false for capabilities that do not parse, and for a stored document that does not', () => {
    expect(canRenderScroll(v3, { documentSchemas: [] })).toBe(false);
    expect(canRenderScroll(v3, null)).toBe(false);
    expect(canRenderScroll({ ...(v3 as object), title: 'x' }, declaring('scroll-document.v3'))).toBe(false);
    expect(canRenderScroll({ ...(v3 as object), sections: [] }, declaring('scroll-document.v3'))).toBe(false);
    expect(canRenderScroll(undefined, declaring('scroll-document.v3'))).toBe(false);
  });

  it('serves a stored v2 whose stage is of a kit the code no longer defines, and still refuses a live kit’s wrong state', () => {
    const stored = v2 as { stage: { kit: string; states: { state: unknown }[] } };
    const states = stored.stage.states.map((entry, index) => ({ ...entry, state: { old: `word ${String(index)}` } }));
    // transit.v1, tides.v1 and star.v1 (#799), greenhouse.v1 and circulation.v1 (#802) and nerve.v1 (#809) were deleted from the code; stage and main still store Scrolls that name them.
    for (const kit of ['gone.v1', 'transit.v1', 'tides.v1', 'star.v1', 'greenhouse.v1', 'circulation.v1', 'nerve.v1'])
      expect(canRenderScroll({ ...stored, stage: { kit, states } }, declaring('scroll-document.v2')), kit).toBe(true);
    expect(
      canRenderScroll({ ...stored, stage: { kit: 'earth-sky.v1', states } }, declaring('scroll-document.v2')),
    ).toBe(false);
  });

  it('names a document v3 by its declared schema', () => {
    expect(isScrollDocumentV3(v3)).toBe(true);
    expect(isScrollDocumentV3(v2)).toBe(false);
    expect(isScrollDocumentV3(null)).toBe(false);
  });
});
