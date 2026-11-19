import { expect, it } from 'vitest';
import { validDocumentV3 } from '../test-support/v3-fixtures.js';
import { beatsOfV3 } from './document.js';
import { LIMITS_V3 } from './limits.js';
import { READING_SECONDS_V3 } from './measures.js';
import { countWords } from '../text.js';

it('the valid fixture sits inside every word and time limit, with room on both sides', () => {
  const document = validDocumentV3();
  const words = beatsOfV3(document).map((beat) => countWords(beat.text));
  expect(Math.max(...words)).toBeLessThan(LIMITS_V3.beatWords);
  expect(words[0]).toBeLessThan(LIMITS_V3.firstBeatWords);
  expect(document.measures.mainWords).toBeGreaterThan(LIMITS_V3.mainWords.min);
  expect(document.measures.mainWords).toBeLessThan(LIMITS_V3.mainWords.max);
  expect(document.measures.readingSeconds).toBeGreaterThan(READING_SECONDS_V3.min);
  expect(document.measures.readingSeconds).toBeLessThan(READING_SECONDS_V3.max);
});
