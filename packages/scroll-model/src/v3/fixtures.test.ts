import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateDocumentV3 } from './validate.js';

/**
 * The committed document v3 fixtures (`fixtures/regenerate-v3.mjs`), re-validated with the measures and the hash: the
 * reader, the gallery and the browser specs draw them, so a stale file would test a document admission refuses.
 */
describe.each(['fence', 'seasons', 'broad-street'])('fixture %s-v3-ci.json', (name) => {
  const document = JSON.parse(
    readFileSync(new URL(`../../fixtures/documents/${name}-v3-ci.json`, import.meta.url), 'utf8'),
  ) as unknown;

  it('is a valid document v3, labelled as a fixture', () => {
    const outcome = validateDocumentV3(document);
    expect(outcome.kind === 'valid' ? [] : outcome.issues).toEqual([]);
    expect(outcome.kind === 'valid' && outcome.document.kicker).toBe('Fixture');
  });
});
