import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  computeIntegrityV2,
  computeMeasuresV2,
  SCROLL_DOCUMENT_V2_SCHEMA_VERSION,
  SCROLL_LIMITS_V2_VERSION,
  type Aside,
  type Recap,
  type Stop,
} from '@knowscroll/scroll-model';
import { parseScrollDocument } from './scroll-document';

const v1 = JSON.parse(
  readFileSync(new URL('../../scroll-model/fixtures/documents/attention-slowly.json', import.meta.url), 'utf8'),
) as unknown;

/** Invented words in sentences of nine to eleven words, so that no sentence is a fact about anything. */
const WORDS = ['amber', 'harbour', 'lantern', 'copper', 'meadow', 'quarry', 'beacon', 'willow', 'ferry', 'granite'];
const filler = (count: number, tag: number): string => {
  const words = Array.from({ length: count }, (_, at) => WORDS[(at * 7 + tag * 3) % WORDS.length] ?? 'amber');
  const sentences: string[] = [];
  for (let at = 0; at < words.length; at += 10) sentences.push(`${words.slice(at, at + 10).join(' ')}.`);
  return sentences.join(' ');
};

/** A labelled CI fixture in `scroll-document.v2`: invented words, real measures and hash, like a stored revision. */
function documentV2(): Record<string, unknown> {
  const read = (at: number): Stop => ({
    kind: 'read',
    id: `s${String(at)}`,
    blocks: [{ type: 'paragraph', text: filler(56, at) }],
    simple: filler(20, at + 30),
  });
  // Each call has its own words, so the Final call is not taken for a restatement of an earlier call.
  const call = (at: number, kind: 'call_it' | 'final_call', prompt: string, options: [string, string]): Stop => ({
    kind,
    id: `s${String(at)}`,
    prompt,
    options,
    answer: 0,
    explain: filler(40, at + 3),
    twist: filler(30, at + 4),
    simple: filler(20, at + 5),
  });
  const stops: Stop[] = [
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(read),
    call(11, 'call_it', 'Which lantern burns longest in the harbour?', ['The copper one', 'The granite one']),
    call(12, 'final_call', 'Who keeps the orchard saddle tidy each autumn?', ['The quarry cook', 'The thistle warden']),
  ].flatMap((stop, index) =>
    index === 4
      ? [
          stop,
          call(20, 'call_it', 'Where does the willow ferry dock at dusk?', ['By the meadow gate', 'Under the beacon']),
        ]
      : [stop],
  );
  const asides: Aside[] = [
    { id: 'a1', kind: 'limits', title: 'Where this stops', text: filler(30, 9), anchorStop: 's8', collapsed: false },
  ];
  const recap: Recap = { captions: [filler(8, 1), filler(8, 2)], smallPrintAside: 'a1' };
  const unsigned = {
    schemaVersion: SCROLL_DOCUMENT_V2_SCHEMA_VERSION,
    assetId: 'ci-fixture-v2-asset',
    revision: 1,
    language: 'en',
    explanationUnitId: 'ci-fixture-v2-unit',
    theme: { family: 'worlds' },
    kicker: 'A closer look',
    title: 'A CI fixture of invented words',
    dek: 'Words made up for a test, never product content.',
    framing: { kind: 'factual' },
    misconception: { kind: 'none' },
    stops,
    asides,
    recap,
    askSuggestions: ['What is this fixture for, exactly?'],
    limitsVersion: SCROLL_LIMITS_V2_VERSION,
    measures: computeMeasuresV2({ stops, asides, recap }),
  };
  return {
    ...unsigned,
    integrity: { method: 'canonical-json-sha256.v1', sha256: computeIntegrityV2(unsigned as never) },
  };
}

describe('the device’s way into a document', () => {
  it('parses a v1 document as v1 and a v2 document as v2', () => {
    expect(parseScrollDocument(v1)).toMatchObject({ kind: 'valid', schema: 'v1' });
    expect(parseScrollDocument(documentV2())).toMatchObject({ kind: 'valid', schema: 'v2' });
    expect(parseScrollDocument(documentV2(), { verify: true })).toMatchObject({ kind: 'valid', schema: 'v2' });
  });

  it('checks a v2 document’s measures and hash only when asked, like v1', () => {
    const tampered = { ...documentV2(), integrity: { method: 'canonical-json-sha256.v1', sha256: 'f'.repeat(64) } };
    expect(parseScrollDocument(tampered).kind).toBe('valid');
    expect(parseScrollDocument(tampered, { verify: true }).kind).toBe('invalid');
  });

  it('refuses what is malformed, in either schema, with codes and paths and no throw', () => {
    expect(parseScrollDocument(null)).toMatchObject({ kind: 'invalid' });
    expect(parseScrollDocument({ schemaVersion: 'scroll-document.v9' })).toMatchObject({
      kind: 'unsupported',
      schemaVersion: 'scroll-document.v9',
    });
    expect(parseScrollDocument({ ...documentV2(), stops: [] })).toMatchObject({ kind: 'invalid' });
    expect(parseScrollDocument({ ...documentV2(), claims: ['internal'] })).toMatchObject({ kind: 'invalid' });
    expect(parseScrollDocument({ ...(v1 as object), sections: 'no' })).toMatchObject({ kind: 'invalid' });
  });
});
