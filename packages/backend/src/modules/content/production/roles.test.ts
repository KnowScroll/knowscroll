import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ScrollDraft, normaliseDraftInput } from '@knowscroll/scroll-model/producer';
import { extractResearch } from '../../../infrastructure/research/public-pages.js';
import { claimsRole, compileGeneratedDraft, generatedProvenance, writerRole } from './roles.js';

const sourceWords =
  'A deliberately labelled fixture evidence passage describes the private research boundary and provides enough stable original language for checking verbatim quotations without representing any real generation.';
const page = extractResearch(
  `<html><title>CI fixture research</title><main>${[0, 1, 2, 3].map((n) => `<p>${sourceWords} Section ${n}.</p>`).join('')}</main></html>`,
  'https://science.nasa.gov/earth/earth-facts/',
  '2026-10-20T00:00:00.000Z',
);
const claims = {
  claims: [0, 1, 2, 3].map((n) => ({
    claimId: `claim-fixture-${n}`,
    pageId: page.id,
    passageId: page.passages[n]?.id ?? '',
    statement: 'A fixture statement is not product content or evidence of a real model invocation.',
    quote: sourceWords,
    truthState: 'documented' as const,
  })),
};
const provenance = generatedProvenance({
  topic: 'greenhouse',
  runId: 'fixture-writer-run',
  attemptIds: ['fixture-attempt'],
  model: 'CI-fixture-only',
  claims,
  pages: [page],
});
function fixtureDraft() {
  const source = JSON.parse(
    readFileSync(new URL('../starter/why-the-sky-is-blue.editorial-scroll.json', import.meta.url), 'utf8'),
  ) as { draft: unknown };
  const draft = ScrollDraft.parse(normaliseDraftInput(source.draft));
  for (const section of draft.sections)
    for (const block of section.blocks) {
      if (block.type !== 'subheading')
        draft.bindings.push({ kind: 'block', blockId: block.id ?? '', claimId: 'claim-fixture-0' });
      if (block.type === 'disclosure')
        for (const child of block.data.blocks)
          draft.bindings.push({ kind: 'block', blockId: child.id ?? '', claimId: 'claim-fixture-0' });
    }
  return draft;
}
describe('Scroll production roles (labelled CI fixture)', () => {
  it('requires exact original quote characters and unique claim identifiers', () => {
    expect(claimsRole([page]).outputSchema.safeParse(claims).success).toBe(true);
    const wrong = structuredClone(claims);
    if (wrong.claims[0]) wrong.claims[0].quote += ' invented';
    expect(claimsRole([page]).outputSchema.safeParse(wrong).success).toBe(false);
    const duplicate = structuredClone(claims);
    if (duplicate.claims[1]) duplicate.claims[1].claimId = 'claim-fixture-0';
    expect(claimsRole([page]).outputSchema.safeParse(duplicate).success).toBe(false);
  });
  it('runs canonical admission and keeps generated provenance separate from the consumer bytes', () => {
    const compiled = compileGeneratedDraft(fixtureDraft(), provenance, false);
    expect(compiled.kind).toBe('compiled');
    if (compiled.kind !== 'compiled') return;
    expect(compiled.provenance).toMatchObject({ production: { model: 'CI-fixture-only' } });
    expect(Array.isArray(compiled.provenance['claims'])).toBe(true);
    for (const hidden of ['claims', 'sources', 'bindings', 'production'])
      expect(compiled.document).not.toHaveProperty(hidden);
    expect(compiled.explanationUnitId).toBe('legacy-cutroom-greenhouse');
  });
  it('puts copy, number, source-name and binding failures inside the same writer schema repair boundary', () => {
    const role = writerRole(provenance, false);
    for (const text of [sourceWords, 'An unexplained count is 99 today.', 'A publisher called NASA said this.']) {
      const draft = fixtureDraft();
      const block = draft.sections[0]?.blocks.find((b) => b.type === 'paragraph');
      if (block?.type === 'paragraph') block.data.spans = [{ text }];
      expect(role.outputSchema.safeParse(draft).success).toBe(false);
    }
    const missing = fixtureDraft();
    missing.bindings = [];
    expect(role.outputSchema.safeParse(missing).success).toBe(false);
  });
});
