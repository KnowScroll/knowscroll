import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { beatsOfV3, beatWords, WORDS_PER_MINUTE_V3, type ScrollDocumentV3 } from '@knowscroll/scroll-model';
import { CANARY_CAPABILITIES, readingUnitsOf } from './document-units.js';

const seasons = JSON.parse(
  readFileSync(
    new URL('../../../../../../scroll-model/fixtures/documents/seasons-v3-ci.json', import.meta.url),
    'utf8',
  ),
) as ScrollDocumentV3;

describe('the canary reads a document v3', () => {
  it('declares every Scroll schema it can read, document v3 included', () => {
    expect(CANARY_CAPABILITIES.documentSchemas).toEqual(
      expect.arrayContaining(['scroll-document.v1', 'scroll-document.v2', 'scroll-document.v3', 'reel-document.v1']),
    );
  });

  it('makes a read unit of each beat, timed by its words at the document pace, and no call', () => {
    const units = readingUnitsOf(seasons);
    const beats = beatsOfV3(seasons);
    expect(units.map((unit) => unit.id)).toEqual(beats.map((beat) => beat.id));
    expect(units.every((unit) => unit.kind === 'read')).toBe(true);
    expect(units.map((unit) => unit.nominalMs)).toEqual(
      beats.map((beat) => Math.round((beatWords(beat) * 60_000) / WORDS_PER_MINUTE_V3)),
    );
  });
});
