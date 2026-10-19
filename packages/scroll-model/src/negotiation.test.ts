import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  AUTHORED_BLOCK_TYPES,
  BASELINE_BLOCKS,
  canonicalJson,
  ClientCapabilities,
  computeIntegrity,
  fallbackTextOf,
  FULL_V1_CAPABILITIES,
  LIMITS,
  negotiate,
  parseCapabilities,
  validateDocument,
  walkBlocks,
  type Block,
  type ScrollDocument,
} from './index.js';
import { arrange, make, scrollDocument, seal, sentence } from './test-support/arbitraries.js';
import { allFixtures, fixture } from './test-support/fixtures.js';

/** Capabilities that always include the baseline; other types supported at v1, a future version, or not at all. */
const capabilities: fc.Arbitrary<ClientCapabilities> = fc
  .array(fc.tuple(fc.constantFrom(...AUTHORED_BLOCK_TYPES), fc.constantFrom<number[]>([1], [2], [1, 2])), {
    maxLength: 16,
  })
  .map((entries) => ({
    documentSchemas: ['scroll-document.v1'],
    blocks: { ...Object.fromEntries(entries), ...Object.fromEntries(BASELINE_BLOCKS.map((type) => [type, [1]])) },
  }));

const documents: fc.Arbitrary<ScrollDocument> = fc.oneof(
  scrollDocument(),
  fc.constantFrom(...allFixtures().map((item) => item.document)),
);

describe('negotiate', () => {
  it('produces a valid rendition that keeps every block id in order', () => {
    fc.assert(
      fc.property(documents, capabilities, (document, caps) => {
        const outcome = negotiate(document, caps);
        expect(outcome.kind).toBe('negotiated');
        if (outcome.kind !== 'negotiated') return;
        const rendition = validateDocument(outcome.document, { purpose: 'rendition' });
        expect(rendition.kind, JSON.stringify(rendition)).toBe('valid');
        const ids = (doc: ScrollDocument) => [...walkBlocks(doc.sections)].map((visit) => visit.block.id);
        expect(ids(outcome.document).filter((id) => ids(document).includes(id))).toEqual(
          ids(document).filter((id) => ids(outcome.document).includes(id)),
        );
        expect(outcome.document.integrity).toEqual(document.integrity);
      }),
      { numRuns: 80 },
    );
  });

  it('never drops an essential block silently: each is unchanged or listed as degraded', () => {
    fc.assert(
      fc.property(documents, capabilities, (document, caps) => {
        const outcome = negotiate(document, caps);
        if (outcome.kind !== 'negotiated') throw new Error(outcome.kind);
        const rendered = new Map(
          [...walkBlocks(outcome.document.sections)].map((visit) => [visit.block.id, visit.block]),
        );
        const degraded = new Set(outcome.degradedEssential.map((entry) => entry.blockId));
        for (const { block } of walkBlocks(document.sections)) {
          if (!block.essential) continue;
          const shown = rendered.get(block.id);
          const unchanged = shown !== undefined && canonicalJson(shown) === canonicalJson(block);
          expect(unchanged || degraded.has(block.id), block.id).toBe(true);
          expect(unchanged && degraded.has(block.id)).toBe(false);
        }
      }),
      { numRuns: 80 },
    );
  });

  it('replaces exactly the unsupported blocks with fallbacks that carry their text, label and essential flag', () => {
    fc.assert(
      fc.property(documents, capabilities, (document, caps) => {
        const outcome = negotiate(document, caps);
        if (outcome.kind !== 'negotiated') throw new Error(outcome.kind);
        const substituted = new Set(outcome.substitutions.map((entry) => entry.blockId));
        const original = new Map([...walkBlocks(document.sections)].map((visit) => [visit.block.id, visit.block]));
        for (const { block } of walkBlocks(outcome.document.sections)) {
          const before = original.get(block.id);
          if (before === undefined) throw new Error(`unknown block ${block.id}`);
          if (substituted.has(block.id)) {
            expect(block).toMatchObject({
              type: 'fallback',
              fallbackText: fallbackTextOf(before),
              a11y: before.a11y,
              essential: before.essential,
              gesture: 'none',
              data: { originalType: before.type, originalVersion: before.version, reason: 'unsupported-by-client' },
            });
            expect((caps.blocks[before.type] ?? []).includes(before.version)).toBe(false);
          } else if (block.type !== 'disclosure') {
            expect(block).toEqual(before);
          }
        }
      }),
      { numRuns: 80 },
    );
  });

  it('gives every rendition a hash of exactly what the client receives', () => {
    fc.assert(
      fc.property(documents, capabilities, (document, caps) => {
        const outcome = negotiate(document, caps);
        if (outcome.kind !== 'negotiated') throw new Error(outcome.kind);
        if (outcome.substitutions.length === 0) {
          expect(outcome.document).toEqual(document);
          return;
        }
        expect(outcome.document.rendition).toEqual({
          method: 'canonical-json-sha256.v1',
          of: document.integrity.sha256,
          sha256: computeIntegrity(outcome.document),
        });
      }),
      { numRuns: 60 },
    );
  });

  it('changes nothing for a client that supports all of v1', () => {
    for (const { document } of allFixtures()) {
      expect(negotiate(document, FULL_V1_CAPABILITIES)).toEqual({
        kind: 'negotiated',
        document,
        substitutions: [],
        degradedEssential: [],
      });
    }
  });

  it('reports an essential child of a substituted disclosure as degraded', () => {
    const child = { ...make('paragraph', { spans: [{ text: 'The key step, inside a reveal.' }] }), essential: true };
    const disclosure = make('disclosure', { summary: 'More', blocks: [child] });
    const document = seal(arrange([{ heading: 'only', blocks: [disclosure] }]));
    const outcome = negotiate(document, {
      documentSchemas: ['scroll-document.v1'],
      blocks: { paragraph: [1], subheading: [1], fallback: [1] },
    });
    if (outcome.kind !== 'negotiated') throw new Error(outcome.kind);
    expect(outcome.substitutions.map((entry) => entry.originalType)).toEqual(['disclosure']);
    expect(outcome.degradedEssential.map((entry) => entry.originalType)).toEqual(['paragraph']);
  });

  it('returns typed outcomes for an unsupported document schema or a missing baseline', () => {
    const document = fixture('weight-other-worlds').document;
    expect(
      negotiate(document, { documentSchemas: ['scroll-document.v2'], blocks: FULL_V1_CAPABILITIES.blocks }),
    ).toEqual({
      kind: 'unsupported-document',
      schemaVersion: 'scroll-document.v1',
    });
    expect(negotiate(document, { documentSchemas: ['scroll-document.v1'], blocks: { paragraph: [1] } })).toEqual({
      kind: 'missing-baseline',
      missing: ['fallback', 'subheading'],
    });
  });

  it('parses the client\u2019s capabilities itself, refusing a huge key set before the schema runs', () => {
    const document = fixture('weight-other-worlds').document;
    expect(negotiate(document, { documentSchemas: [], blocks: {} })).toMatchObject({ kind: 'invalid-capabilities' });
    expect(negotiate(document, 'everything')).toMatchObject({ kind: 'invalid-capabilities' });
    const blocks = Object.fromEntries(
      Array.from({ length: 200_000 }, (_, index) => [`type-${index.toString(36).replace(/\d/gu, 'x')}${index}`, [1]]),
    );
    const started = performance.now();
    expect(parseCapabilities({ documentSchemas: ['scroll-document.v1'], blocks })).toEqual({
      kind: 'invalid',
      issues: [{ code: 'schema_too_big', path: 'blocks' }],
    });
    expect(performance.now() - started).toBeLessThan(100);
  });

  it('parses advertised capabilities strictly', () => {
    expect(ClientCapabilities.safeParse(FULL_V1_CAPABILITIES).success).toBe(true);
    expect(ClientCapabilities.safeParse({ documentSchemas: [], blocks: {} }).success).toBe(false);
    expect(
      ClientCapabilities.safeParse({ documentSchemas: ['scroll-document.v1'], blocks: { Chart: [1] } }).success,
    ).toBe(false);
    expect(
      ClientCapabilities.safeParse({ documentSchemas: ['scroll-document.v1'], blocks: { chart: [0] } }).success,
    ).toBe(false);
  });
});

/**
 * Documents pushed as close to the limits as they go: padding blocks (long paragraphs, non-text
 * blocks with long fallback text, lists and callouts whose derived fallback is longer than their
 * text) are added until the stored document would be refused, so every limit is within one block.
 */
const padding: fc.Arbitrary<Block> = fc.oneof(
  fc
    .integer({ min: 200, max: 1_190 })
    .map((length) => make('paragraph', { spans: [{ text: `${'Word '.repeat(Math.floor(length / 5)).trim()}.` }] })),
  fc.integer({ min: 40, max: 1_190 }).map((length) => ({
    ...make('code', { language: 'text', code: 'x = 1' }),
    a11y: { label: 'Code', description: `${'Spoken description '.repeat(31).slice(0, 590).trim()}.` },
    fallbackText: `${'Code words '
      .repeat(Math.ceil(length / 11))
      .slice(0, length - 1)
      .trim()}.`,
  })),
  fc.constant({
    ...make('media', {
      kind: 'audio',
      media: { mediaId: 'med-1', revision: 1 },
      alt: `${'A recording of the sea '.repeat(13).slice(0, 290).trim()}.`,
      transcript: `${'Waves fold onto the shore '.repeat(46).slice(0, 1_190).trim()}.`,
      durationMs: 30_000,
    }),
    a11y: { label: 'Audio', description: `${'Spoken description '.repeat(31).slice(0, 590).trim()}.` },
  }),
  fc
    .array(sentence(8, 12), { minLength: 2, maxLength: 8 })
    .map((items) => make('list', { style: 'bullet', items: items.map((text) => [{ text }]) })),
  fc
    .tuple(sentence(2, 4), sentence(10, 12))
    .map(([title, text]) =>
      make('callout', { kind: 'note', title: title.slice(0, 60).replace(/\.$/u, ''), spans: [{ text }] }),
    ),
);

function nearLimit(base: ScrollDocument, extra: readonly Block[]): ScrollDocument {
  const build = (count: number) => {
    const sections = base.sections.map((section) => ({ ...section }));
    const added = extra.slice(0, count).map((block, index) => ({ ...block, id: `pad-${index}` }));
    const room = LIMITS.blocks - [...walkBlocks(sections)].length;
    const tail: (typeof sections)[number] = {
      id: 'padding',
      heading: 'Padding',
      blocks: added.slice(0, Math.max(0, room)),
    };
    return seal(tail.blocks.length > 0 && sections.length < LIMITS.sections ? [...sections, tail] : sections);
  };
  let low = 0;
  let high = extra.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (validateDocument(build(middle)).kind === 'valid') low = middle;
    else high = middle - 1;
  }
  return build(low);
}

describe('negotiate near the limits', () => {
  it('never turns a valid stored document into an invalid rendition', () => {
    fc.assert(
      fc.property(
        scrollDocument(3, 4),
        fc.array(padding, { minLength: 10, maxLength: 70 }),
        capabilities,
        (base, extra, caps) => {
          const document = nearLimit(base, extra);
          expect(validateDocument(document).kind).toBe('valid');
          const outcome = negotiate(document, caps);
          if (outcome.kind !== 'negotiated') throw new Error(outcome.kind);
          const rendition = validateDocument(outcome.document, { purpose: 'rendition' });
          expect(rendition.kind, JSON.stringify(rendition)).toBe('valid');
        },
      ),
      { numRuns: 25 },
    );
  });
});
