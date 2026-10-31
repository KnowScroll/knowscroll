import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateDocumentV2 } from './validate.js';

const NAMES = ['sort-fork-blocks', 'scale-chart-blocks'] as const;
const fixture = (name: (typeof NAMES)[number]): unknown =>
  JSON.parse(readFileSync(new URL(`../../fixtures/documents/${name}-ci.json`, import.meta.url), 'utf8'));

/** The labelled CI fixtures the reader's tests, the axe check and the block screenshots read. Not product content. */
describe.each(NAMES)('the CI fixture %s', (name) => {
  it('is a valid scroll-document.v2, short: the reading time is the one thing it fails', () => {
    const outcome = validateDocumentV2(fixture(name), { verify: false });
    if (outcome.kind !== 'valid') throw new Error(JSON.stringify(outcome.issues));
    expect(outcome.document.kicker).toMatch(/CI fixture/);
    const full = validateDocumentV2(fixture(name));
    expect(full.kind === 'invalid' ? full.issues.map((issue) => issue.code) : []).toEqual([
      'reading_length_out_of_brief',
    ]);
  });
});

it('between them the fixtures hold every play block and the guide', () => {
  const kinds = new Set<string>();
  let guides = 0;
  for (const name of NAMES) {
    const outcome = validateDocumentV2(fixture(name), { verify: false });
    if (outcome.kind !== 'valid') throw new Error('valid');
    for (const stop of outcome.document.stops) {
      if (stop.kind !== 'read') continue;
      if (stop.interactive !== undefined) kinds.add(stop.interactive.type);
      if (stop.guide !== undefined) guides += 1;
    }
  }
  expect([...kinds].sort()).toEqual(['chart', 'fork', 'scale', 'sort']);
  expect(guides).toBe(3);
});
