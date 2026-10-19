import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  FULL_V1_CAPABILITIES,
  isInteractiveBlock,
  isTextBlockType,
  LIMITS,
  negotiate,
  validateDocument,
  walkBlocks,
} from './index.js';
import { ScrollProvenance } from './internal/index.js';
import { compileDraft, draftFromDocument } from './producer/index.js';
import { allFixtures, fixture } from './test-support/fixtures.js';

describe('labelled fixtures (CI fixtures, not product content)', () => {
  for (const item of allFixtures()) {
    describe(item.name, () => {
      it('is labelled as a fixture in its provenance', () => {
        expect(item.provenance.production.kind).toBe('fixture');
        expect(item.internal.production.kind).toBe('fixture');
      });

      it('compiles from its draft to exactly the committed document and internal provenance', () => {
        const outcome = compileDraft(item.draft, item.provenance);
        expect(outcome.kind, JSON.stringify(outcome.kind === 'refused' ? outcome.issues : [])).toBe('compiled');
        if (outcome.kind !== 'compiled') return;
        expect(outcome.document).toEqual(item.document);
        expect(outcome.internalProvenance).toEqual(item.internal);
      });

      it('is a valid stored revision within scroll-limits.v1', () => {
        expect(validateDocument(item.document)).toEqual({ kind: 'valid', document: item.document });
        expect(ScrollProvenance.safeParse(item.internal).success).toBe(true);
        expect(item.internal.documentSha256).toBe(item.document.integrity.sha256);
      });

      it('compiles idempotently: draftFromDocument of the output compiles to the same output', () => {
        const again = compileDraft(draftFromDocument(item.document, item.internal.bindings), item.provenance);
        expect(again.kind).toBe('compiled');
        if (again.kind !== 'compiled') return;
        expect(canonicalJson(again.document)).toBe(canonicalJson(item.document));
        expect(again.internalProvenance).toEqual(item.internal);
      });

      it('keeps claims, sources and production data out of the consumer document', () => {
        const text = canonicalJson(item.document);
        for (const forbidden of [
          'claimId',
          'sourceId',
          'snapshotSha256',
          'https://',
          'fixture.invalid',
          'science.nasa',
          'clm-',
          'src-',
        ]) {
          expect(text).not.toContain(forbidden);
        }
      });

      it('needs no substitution on a full v1 client', () => {
        const outcome = negotiate(item.document, FULL_V1_CAPABILITIES);
        expect(outcome.kind).toBe('negotiated');
        if (outcome.kind !== 'negotiated') return;
        expect(outcome.substitutions).toEqual([]);
        expect(outcome.document).toEqual(item.document);
      });

      it('stays within the interactive-block limit', () => {
        const interactive = [...walkBlocks(item.document.sections)].filter((visit) => isInteractiveBlock(visit.block));
        expect(interactive.length).toBeGreaterThan(0);
        expect(interactive.length).toBeLessThanOrEqual(LIMITS.interactiveBlocks);
      });
    });
  }

  it('include a simulation driven by a slider and a diagram switched by steps', () => {
    const blocks = allFixtures().flatMap((item) => [...walkBlocks(item.document.sections)].map((visit) => visit.block));
    expect(
      blocks.some(
        (block) => block.type === 'simulation' && block.data.params.some((param) => param.control === 'slider'),
      ),
    ).toBe(true);
    expect(blocks.some((block) => block.type === 'diagram' && block.data.interaction.kind === 'steps')).toBe(true);
    expect(blocks.some((block) => block.type === 'diagram' && block.data.interaction.kind === 'drag-to-target')).toBe(
      true,
    );
  });

  it('derive gestures from content: slider and code are horizontal, drag-to-target is two-axis, the rest none', () => {
    const attention = fixture('attention-slowly').document;
    const gestures = Object.fromEntries(
      [...walkBlocks(attention.sections)].map((visit) => [visit.block.id, visit.block.gesture]),
    );
    expect(gestures).toMatchObject({
      'it-diagram': 'two-axis',
      'length-sim': 'horizontal',
      'attention-code': 'horizontal',
      'grid-chart': 'none',
      'crowd-p1': 'none',
    });
    const weight = fixture('weight-other-worlds').document;
    expect(weight.sections[0]?.blocks[0]).toMatchObject({ id: 'weight-sim', gesture: 'none' });
  });

  it('store no fallback text on text blocks (it is derived), and mark illustrative simulations visibly', () => {
    for (const item of allFixtures()) {
      for (const { block } of walkBlocks(item.document.sections)) {
        if (isTextBlockType(block.type)) expect('fallbackText' in block, block.id).toBe(false);
        if (block.type === 'simulation' && block.data.illustrative !== false) {
          expect(block.data.illustrative).toEqual({ notice: 'Illustrative' });
        }
      }
    }
    const illustrative = allFixtures().flatMap((item) =>
      [...walkBlocks(item.document.sections)].flatMap((visit) =>
        visit.block.type === 'simulation' ? [[visit.block.id, visit.block.data.illustrative !== false] as const] : [],
      ),
    );
    expect(Object.fromEntries(illustrative)).toEqual({ 'length-sim': true, 'weight-sim': false, 'range-sim': true });
  });

  it('export only consumer documents to other packages (never drafts or internal provenance)', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      exports: Record<string, unknown>;
    };
    const fixtureExports = Object.entries(manifest.exports).filter(([key]) => key.startsWith('./fixtures'));
    expect(fixtureExports).toEqual([['./fixtures/*.json', './fixtures/documents/*.json']]);
  });

  it('carry a personal parameter only where the reader enters their own data', () => {
    const personal = allFixtures().flatMap((item) =>
      [...walkBlocks(item.document.sections)].flatMap((visit) =>
        visit.block.type === 'simulation'
          ? visit.block.data.params.filter((param) => param.personal === true).map((param) => param.key)
          : [],
      ),
    );
    expect(personal).toEqual(['weightKg']);
  });
});
