import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ExposureDocumentResponseSchema } from './index.js';

/** scroll-model's labelled CI fixtures: a Scroll v1, a v2 with a stage and a document v3. Not product content. */
const fixture = (name: string): { [key: string]: unknown } =>
  JSON.parse(readFileSync(new URL(`../../scroll-model/fixtures/documents/${name}.json`, import.meta.url), 'utf8')) as {
    [key: string]: unknown;
  };

const response = (document: unknown) => ({
  exposureId: '0199f0a0-0000-7000-8000-000000000001',
  assetId: '0199f0a0-0000-7000-8000-000000000002',
  assetRevision: 1,
  document,
  degradedEssential: [],
});

describe('the served document of an exposure', () => {
  it.each([
    ['a Scroll v1', 'attention-slowly'],
    ['a Scroll v2', 'seasons-stage-ci'],
    ['a document v3', 'seasons-v3-ci'],
  ])('accepts %s, whole, as its own schema names it', (_name, file) => {
    const document = fixture(file);
    const parsed = ExposureDocumentResponseSchema.parse(response(document));
    expect(parsed.document).toEqual(document);
  });

  it('does not strip or admit anything of a document v3: an unknown field is refused, not dropped', () => {
    const document = fixture('seasons-v3-ci');
    expect(ExposureDocumentResponseSchema.safeParse(response({ ...document, claims: ['secret'] })).success).toBe(false);
    expect(
      ExposureDocumentResponseSchema.safeParse(response({ ...document, schemaVersion: 'scroll-document.v4' })).success,
    ).toBe(false);
  });

  it('serves a stored Scroll v2 whose stage names any kit, whole: the code defines none', () => {
    const document = fixture('seasons-stage-ci') as { stage: { kit: string; states: { state: unknown }[] } };
    const states = document.stage.states.map((entry, index) => ({ ...entry, state: { old: `word ${String(index)}` } }));
    // transit.v1, tides.v1 and star.v1 (#799), greenhouse.v1 and circulation.v1 (#802), nerve.v1 (#809), black-hole.v1 (#832), starlight.v1 (#834) and earth-sky.v1 (#835) were deleted from the code; stage and main still store Scrolls that name them.
    for (const kit of [
      'gone.v1',
      'transit.v1',
      'tides.v1',
      'star.v1',
      'greenhouse.v1',
      'circulation.v1',
      'nerve.v1',
      'black-hole.v1',
      'starlight.v1',
      'earth-sky.v1',
    ]) {
      const legacy = { ...document, stage: { kit, states } };
      expect(ExposureDocumentResponseSchema.parse(response(legacy)).document, kit).toEqual(legacy);
    }
    const malformed = { ...document, stage: { kit: 'constructor', states } };
    expect(ExposureDocumentResponseSchema.safeParse(response(malformed)).success).toBe(false);
  });
});
