import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { negotiate, parseBlock, validateDocument, type Block, type ScrollDocument } from './index.js';
import { arrange, make, scrollDocument, seal } from './test-support/arbitraries.js';
import { fixture } from './test-support/fixtures.js';
import { fastestMs } from './test-support/timing.js';

const codes = (outcome: ReturnType<typeof validateDocument>) =>
  outcome.kind === 'invalid' ? outcome.issues.map((issue) => issue.code) : [];

const paragraph = (text: string) => make('paragraph', { spans: [{ text }] });

function documentWith(blocks: Block[]): ScrollDocument {
  return seal(arrange([{ heading: 'only', blocks }]));
}

/** One section with these blocks as they are (no limit-keeping substitutions). */
function documentOfExactly(blocks: Block[]): ScrollDocument {
  return seal([
    { id: 'only', heading: null, blocks: blocks.map((block, index) => ({ ...block, id: `block-${index}` })) },
  ]);
}

describe('validateDocument: typed outcomes', () => {
  it('accepts every generated document within scroll-limits.v1 as a stored revision', () => {
    fc.assert(
      fc.property(scrollDocument(), (document) => {
        const outcome = validateDocument(document);
        expect(outcome.kind, JSON.stringify(codes(outcome))).toBe('valid');
      }),
      { numRuns: 60 },
    );
  });

  it('refuses anything that is not an object with document_not_object', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null), fc.array(fc.anything())),
        (value) => {
          expect(validateDocument(value)).toEqual({
            kind: 'invalid',
            issues: [{ code: 'document_not_object', path: '$' }],
          });
        },
      ),
    );
  });

  it('reports any other schema version as unsupported-version, never as a parse error', () => {
    const document = fixture('attention-slowly').document;
    fc.assert(
      fc.property(
        fc.string({ maxLength: 40 }).filter((version) => version !== 'scroll-document.v1'),
        (schemaVersion) => {
          expect(validateDocument({ ...document, schemaVersion })).toEqual({
            kind: 'unsupported-version',
            schemaVersion,
          });
        },
      ),
    );
    const { schemaVersion: _removed, ...unversioned } = document;
    expect(validateDocument(unversioned)).toEqual({ kind: 'unsupported-version', schemaVersion: null });
    expect(validateDocument({ ...document, schemaVersion: 2 })).toEqual({
      kind: 'unsupported-version',
      schemaVersion: null,
    });
  });

  it('reports unknown block types and versions with their own codes and paths', () => {
    const document = fixture('spring-neap-tides').document;
    const block = document.sections[0]?.blocks[0];
    fc.assert(
      fc.property(
        fc
          .stringMatching(/^[a-z][a-z-]{1,20}$/u)
          .filter(
            (type) =>
              ![
                'paragraph',
                'subheading',
                'list',
                'quote',
                'callout',
                'disclosure',
                'code',
                'table',
                'figure',
                'media',
                'comparison',
                'timeline',
                'sequence',
                'diagram',
                'chart',
                'simulation',
                'fallback',
              ].includes(type),
          ),
        fc.integer({ min: 2, max: 99 }),
        (type, version) => {
          const withType = structuredClone(document) as unknown as {
            sections: Array<{ blocks: Array<Record<string, unknown>> }>;
          };
          const first = withType.sections[0]?.blocks[0];
          if (first !== undefined) first['type'] = type;
          expect(validateDocument(withType)).toEqual({
            kind: 'invalid',
            issues: [{ code: 'block_type_unknown', path: 'sections.0.blocks.0.type' }],
          });
          const withVersion = structuredClone(document) as unknown as {
            sections: Array<{ blocks: Array<Record<string, unknown>> }>;
          };
          const again = withVersion.sections[0]?.blocks[0];
          if (again !== undefined) again['version'] = version;
          expect(validateDocument(withVersion)).toEqual({
            kind: 'invalid',
            issues: [{ code: 'block_version_unknown', path: 'sections.0.blocks.0.version' }],
          });
        },
      ),
      { numRuns: 50 },
    );
    expect(block?.id).toBe('pulls-p1');
  });

  it('refuses a stored revision whose integrity, measures or gestures were not computed by code', () => {
    const document = fixture('attention-slowly').document;
    expect(codes(validateDocument({ ...document, title: 'Attention, quickly' }))).toEqual(['integrity_mismatch']);
    const measures = { ...document.measures, readingMinutes: document.measures.readingMinutes + 5 };
    // Changing the measures also changes what the integrity hash covers, so both are reported.
    expect(codes(validateDocument({ ...document, measures }))).toEqual(['measures_mismatch', 'integrity_mismatch']);
    const flipped = structuredClone(document);
    const diagram = flipped.sections[0]?.blocks[2];
    if (diagram !== undefined) diagram.gesture = 'none';
    expect(codes(validateDocument(flipped))).toContain('gesture_mismatch');
  });

  it('allows fallback blocks only in client renditions', () => {
    const document = fixture('attention-slowly').document;
    const outcome = negotiate(document, {
      documentSchemas: ['scroll-document.v1'],
      blocks: { paragraph: [1], subheading: [1], fallback: [1] },
    });
    if (outcome.kind !== 'negotiated') throw new Error(outcome.kind);
    expect(validateDocument(outcome.document, { purpose: 'rendition' }).kind).toBe('valid');
    const stored = seal(outcome.document.sections);
    expect(codes(validateDocument(stored))).toContain('fallback_in_stored_document');
    // The rendition carries a hash of exactly what the client received.
    expect(outcome.document.rendition).toMatchObject({ of: document.integrity.sha256 });
    expect(
      codes(validateDocument({ ...outcome.document, title: 'Attention, quickly' }, { purpose: 'rendition' })),
    ).toEqual(['rendition_integrity_mismatch']);
    expect(codes(validateDocument(outcome.document))).toContain('rendition_in_stored_document');
  });

  it('checks nesting depth and byte size before anything else, and refuses them cheaply', () => {
    const document = fixture('weight-other-worlds').document;
    let deep: unknown = 'leaf';
    for (let level = 0; level < 5_000; level += 1) deep = [deep];
    expect(validateDocument({ ...document, sections: deep })).toEqual({
      kind: 'invalid',
      issues: [{ code: 'document_too_deep', path: '$' }],
    });
    const huge = { ...document, kicker: 'x'.repeat(200_000) };
    expect(validateDocument(huge)).toEqual({ kind: 'invalid', issues: [{ code: 'document_too_large', path: '$' }] });
    expect(fastestMs(() => validateDocument(huge))).toBeLessThan(200);
  });

  it('caps figure and media blocks at 12', () => {
    const figure = () =>
      make('figure', { media: { mediaId: 'med-1', revision: 1 }, motion: 'still', alt: 'A quiet harbour at dawn.' });
    expect(validateDocument(documentOfExactly(Array.from({ length: 12 }, figure))).kind).toBe('valid');
    expect(codes(validateDocument(documentOfExactly(Array.from({ length: 13 }, figure))))).toEqual(['too_many_media']);
  });

  it('refuses a log axis whose domain reaches zero or below', () => {
    const chart = make('chart', {
      title: 'Bars',
      spec: {
        kind: 'bar',
        orientation: 'vertical',
        categories: ['a', 'b'],
        series: [{ id: 'only', label: 'only', values: [2, 3] }],
        valueAxis: { label: 'v', scale: 'log', domain: [-5, 10] },
      },
    });
    expect(codes(validateDocument(documentWith([chart])))).toEqual(['chart_log_scale']);
  });

  it('requires a heading on every section after the first and unique ids', () => {
    const sections = arrange([
      { heading: 'one', blocks: [paragraph('First words here.')] },
      { heading: 'two', blocks: [paragraph('Second words here.')] },
    ]);
    const untitled = sections.map((section, index) => (index === 1 ? { ...section, heading: null } : section));
    expect(codes(validateDocument(seal(untitled)))).toEqual(['heading_missing']);
    const duplicate = sections.map((section, index) =>
      index === 1 ? { ...section, blocks: section.blocks.map((block) => ({ ...block, id: 'block-1' })) } : section,
    );
    expect(codes(validateDocument(seal(duplicate)))).toEqual(['id_duplicate']);
  });

  it('refuses short fallback text on authored non-text blocks', () => {
    const figure = make('figure', {
      media: { mediaId: 'med-1', revision: 1 },
      motion: 'still',
      alt: 'A quiet harbour at dawn.',
    });
    expect(codes(validateDocument(documentWith([{ ...figure, fallbackText: 'Too short.' }])))).toEqual([
      'fallback_text_too_short',
    ]);
  });
});

describe('parseBlock: defensive per-block parsing for renderers', () => {
  const block = fixture('attention-slowly').document.sections[1]?.blocks[2];
  const fallbackText = block !== undefined && 'fallbackText' in block ? block.fallbackText : undefined;

  it('returns a valid block', () => {
    expect(parseBlock(block)).toEqual({ kind: 'block', block });
  });

  it('keeps the envelope of an unknown type or version so the fallback text can still be shown', () => {
    const unknownType = parseBlock({ ...block, type: 'hologram' });
    expect(unknownType).toMatchObject({
      kind: 'unsupported',
      reason: 'unknown-type',
      envelope: { id: 'length-sim', type: 'hologram', fallbackText, essential: true },
    });
    expect(parseBlock({ ...block, version: 2 })).toMatchObject({ kind: 'unsupported', reason: 'unknown-version' });
  });

  it('reports invalid data with issues and whatever envelope fields are valid', () => {
    const outcome = parseBlock({ ...block, data: { title: 'broken' } });
    expect(outcome.kind).toBe('invalid');
    if (outcome.kind === 'invalid') {
      expect(outcome.envelope.fallbackText).toBe(fallbackText);
      expect(outcome.issues.length).toBeGreaterThan(0);
    }
    expect(parseBlock(42)).toMatchObject({ kind: 'invalid', envelope: { id: null, fallbackText: null } });
  });

  it('never throws, whatever it is given', () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        expect(['block', 'unsupported', 'invalid']).toContain(parseBlock(value).kind);
      }),
    );
  });
});
