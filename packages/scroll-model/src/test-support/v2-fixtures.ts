import { readFileSync } from 'node:fs';
import type { ScrollDocumentV2 } from '../v2/document.js';

/**
 * CI FIXTURES for `scroll-document.v2`, never product content. The stop texts are generated filler of invented words, so
 * that no run of nine words can match any evidence and the reading time lands where the tests need it.
 */

/**
 * The stored v2 Scroll about the invented planet Orrin that the reading side's tests read: eight stops, two Call its and a
 * Final call, a limits aside, a recap and questions, with a pinned picture (`stage`) or without (`plain`). It is a committed
 * snapshot (`orrin-v2/*.json`) of what the v2 assembler made of that authored Scroll before the v2 writing side was deleted
 * (#815): code that reads a stored v2 revision is tested on a document as the old production stored it, never on a producer.
 * Each call gives a fresh copy, so a test may change it.
 */
export function orrinDocumentV2(variant: 'stage' | 'plain' = 'stage'): ScrollDocumentV2 {
  return JSON.parse(readFileSync(new URL(`./orrin-v2/${variant}.json`, import.meta.url), 'utf8')) as ScrollDocumentV2;
}

const WORDS = [
  'amber',
  'harbour',
  'lantern',
  'copper',
  'meadow',
  'quarry',
  'beacon',
  'willow',
  'ferry',
  'granite',
  'orchard',
  'saddle',
  'thistle',
  'anchor',
  'bramble',
  'cinder',
  'drizzle',
  'ember',
  'fennel',
  'gable',
  'hollow',
  'ivory',
  'juniper',
  'kettle',
  'linen',
  'mantle',
  'nettle',
  'oakum',
  'pewter',
  'quilt',
];

/** `count` invented words in sentences of nine to eleven words; `tag` makes each text different. */
export function filler(count: number, tag: number): string {
  const sentences: string[] = [];
  let words: string[] = [];
  for (let at = 0; at < count; at += 1) {
    words.push(WORDS[(at * 7 + tag * 13) % WORDS.length] ?? 'amber');
    if (words.length === 9 + (at % 3) || at === count - 1) {
      const sentence = words.join(' ');
      sentences.push(`${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`);
      words = [];
    }
  }
  return sentences.join(' ');
}
