import { describe, expect, it } from 'vitest';
import { REASON_CODES } from '../../issues.js';
import { V3_REASON_CODES } from '../../v3/issues.js';
import { REPAIR_HINTS_V3 } from './reasons.js';
import { writtenReferenceV3 } from './written-reference.js';

/** The harness's rules for a repair catalogue: keys `^[a-z][a-z0-9_]{0,63}$`, hints 1 to 256 characters without control characters. */
const KEY = /^[a-z][a-z0-9_]{0,63}$/u;
const hasControl = (text: string): boolean =>
  Array.from(text).some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  });

describe('REPAIR_HINTS_V3', () => {
  it('fits the harness rules and leaves room for the backend’s own codes', () => {
    const entries = Object.entries(REPAIR_HINTS_V3);
    expect(entries.length).toBeLessThanOrEqual(110);
    for (const [code, hint] of entries) {
      expect(code).toMatch(KEY);
      expect(hint.length, code).toBeGreaterThanOrEqual(1);
      expect(hint.length, code).toBeLessThanOrEqual(256);
      expect(hasControl(hint), code).toBe(false);
    }
  });

  it('has a hint for every document v3 code, so that a finding is never silent', () => {
    for (const code of V3_REASON_CODES) expect(REPAIR_HINTS_V3[code], code).toBeDefined();
  });

  it('has a hint for the schema, evidence, size and measure codes the compile can return', () => {
    const codes = [
      'schema_invalid_type',
      'schema_too_small',
      'schema_too_big',
      'schema_invalid_format',
      'schema_invalid_value',
      'schema_unrecognized_keys',
      'schema_invalid_union',
      'schema_invalid',
      'text_not_plain',
      'text_mentions_web_address',
      'id_format',
      'authoring_cite_unknown',
      'authoring_too_few_cites',
      'authoring_number_not_in_evidence',
      'authoring_reference_unknown',
      'copied_passage',
      'document_too_large',
      'measures_mismatch',
      'integrity_mismatch',
      'reading_length_out_of_brief',
      'id_duplicate',
    ];
    for (const code of codes) expect(REPAIR_HINTS_V3[code], code).toBeDefined();
  });

  it('names no code that does not exist', () => {
    const known = new Set<string>([...REASON_CODES, ...V3_REASON_CODES, 'figure_format']);
    for (const code of Object.keys(REPAIR_HINTS_V3)) expect(known.has(code), code).toBe(true);
  });
});

describe('writtenReferenceV3', () => {
  const KINDS = ['statement', 'flow', 'cycle', 'grid', 'chart', 'plan'];

  it('shows one example of every picture kind to the writer of a whole Scroll and to the stager', () => {
    for (const arm of ['one', 'staging'] as const) {
      const text = writtenReferenceV3(arm);
      for (const kind of KINDS) expect(text, `${arm} ${kind}`).toContain(`"kind":"${kind}"`);
    }
  });

  it('tells a chart writer that "marks" is always written, and an empty list when no point needs one (D-441)', () => {
    for (const arm of ['one', 'staging'] as const) {
      const chart = writtenReferenceV3(arm)
        .split('\n')
        .find((line) => line.includes('"kind":"chart"'));
      expect(chart, arm).toContain('"marks":[{"point"');
      expect(chart, arm).toContain('"marks" is ALWAYS written');
      expect(chart, arm).toContain('"marks":[] when no point needs a label');
    }
  });

  it('shows the prose writer no picture, show, link or control', () => {
    const text = writtenReferenceV3('prose');
    for (const word of ['"kind":"flow"', '"show"', '"links"', '"control"', '"pictures"'])
      expect(text).not.toContain(word);
    expect(text).toContain('"type":"para"');
  });

  it('shows the stager the stage but no prose item', () => {
    const text = writtenReferenceV3('staging');
    expect(text).toContain('"stage"');
    expect(text).not.toContain('"type":"para"');
  });

  it('writes no id in any example', () => {
    for (const arm of ['one', 'prose', 'staging'] as const) expect(writtenReferenceV3(arm)).not.toMatch(/"id":/u);
  });
});
