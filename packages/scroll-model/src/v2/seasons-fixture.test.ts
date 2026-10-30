import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { callsOf } from './document.js';
import { validateDocumentV2 } from './validate.js';

const fixture: unknown = JSON.parse(
  readFileSync(new URL('../../fixtures/documents/seasons-stage-ci.json', import.meta.url), 'utf8'),
);

/** The labelled CI fixture the Stage + Spine reader's tests and screenshots read. Not product content. */
describe('the seasons stage CI fixture', () => {
  it('is a valid scroll-document.v2 with its measures and hash checked', () => {
    const outcome = validateDocumentV2(fixture);
    if (outcome.kind !== 'valid') throw new Error(JSON.stringify(outcome.issues));
    expect(outcome.document.kicker).toMatch(/CI fixture/);
    expect(outcome.document.stage?.states.length).toBeGreaterThanOrEqual(3);
    expect(callsOf(outcome.document).map((call) => call.kind)).toEqual(['call_it', 'call_it', 'final_call']);
  });
});
