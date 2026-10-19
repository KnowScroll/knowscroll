import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  AUTHORED_BLOCK_TYPES,
  BASELINE_BLOCKS,
  canonicalJson,
  ClientCapabilities,
  FULL_V1_CAPABILITIES,
  negotiate,
  validateDocument,
  walkBlocks,
  type ScrollDocument,
} from './index.js';
import { arrange, make, scrollDocument, seal } from './test-support/arbitraries.js';
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
              fallbackText: before.fallbackText,
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
