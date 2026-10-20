import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  type DraftProvenance,
  ScrollDraft,
  blockCatalogueText,
  normaliseDraftInput,
} from '@knowscroll/scroll-model/producer';
import { extractResearch } from '../../../infrastructure/research/public-pages.js';
import { MAX_INSTRUCTION_CHARS } from '../../../reasoning/public.js';
import {
  claimsRole,
  compileGeneratedDraft,
  generatedProvenance,
  writerRole,
  CLAIMS_ROLE_VERSION,
  WRITER_PROMPT_VERSION,
} from './roles.js';
import { writerDraftExampleJson } from './writer-example.js';
import { hydrateSelectedClaims, quoteCandidates } from './quote-candidates.js';

const sourceWords =
  'A deliberately labelled fixture evidence passage describes the private research boundary and provides enough stable original language for checking verbatim quotations without representing any real generation.';
const page = extractResearch(
  `<html><title>CI fixture research</title><main>${[0, 1, 2, 3].map((n) => `<p>${sourceWords} Section ${n}.</p>`).join('')}</main></html>`,
  'https://science.nasa.gov/earth/earth-facts/',
  '2026-10-20T00:00:00.000Z',
);
const candidates = quoteCandidates([page]);
const selection = { candidateIds: candidates.slice(0, 4).map(({ id }) => id) };
const claims = hydrateSelectedClaims([page], candidates, selection.candidateIds);
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
        draft.bindings.push({ kind: 'block', blockId: block.id ?? '', claimId: claims.claims[0]?.claimId ?? '' });
      if (block.type === 'disclosure')
        for (const child of block.data.blocks)
          draft.bindings.push({ kind: 'block', blockId: child.id ?? '', claimId: claims.claims[0]?.claimId ?? '' });
    }
  return draft;
}
describe('Scroll production roles (labelled CI fixture)', () => {
  it('hydrates only distinct offered IDs and rejects model-authored claim fields', () => {
    const role = claimsRole([page]);
    const accepted = role.outputSchema.safeParse(selection);
    expect(accepted.success).toBe(true);
    if (accepted.success) {
      expect(accepted.data).toEqual(claims);
      for (const claim of accepted.data.claims) {
        expect(claim.statement).toBe(claim.quote);
        expect(claim.truthState).toBe('documented');
        expect(claim.claimId).toMatch(/^claim-[a-z0-9-]{1,48}$/u);
        expect(page.passages.find(({ id }) => id === claim.passageId)?.text).toContain(claim.quote);
      }
    }
    expect(role.outputSchema.safeParse({ candidateIds: Array(4).fill(selection.candidateIds[0]) }).success).toBe(false);
    expect(
      role.outputSchema.safeParse({ candidateIds: [...selection.candidateIds.slice(0, 3), `q-${'0'.repeat(48)}`] })
        .success,
    ).toBe(false);
    expect(role.outputSchema.safeParse({ ...selection, truthState: 'documented' }).success).toBe(false);
    expect(role.outputSchema.safeParse(claims).success).toBe(false);
    const mutable = { ...page, passages: page.passages.map((p) => ({ ...p })) };
    const frozenRole = claimsRole([mutable]);
    if (mutable.passages[0])
      mutable.passages[0] = { ...mutable.passages[0], text: `${mutable.passages[0].text} tampered` };
    expect(frozenRole.outputSchema.safeParse(selection).success).toBe(false);
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
  it('embeds one valid fictional JSON draft that compiles only with synthetic example evidence', () => {
    const json = writerDraftExampleJson();
    const example: unknown = JSON.parse(json);
    expect(ScrollDraft.safeParse(example).success).toBe(true);
    const synthetic: DraftProvenance = {
      ...provenance,
      publication: {
        ...provenance.publication,
        assetId: 'example-only-asset',
        explanationUnitId: 'example-only-explanation',
        targetMinutes: [1, 1],
      },
      claims: [
        {
          claimId: 'example-only-claim',
          sourceId: 'example-only-source',
          statement: 'Assume an invented switch whose selected state controls whether a drawn connection exists.',
          quote:
            'This authored test stipulates a fictional connection that can be shown or hidden by selecting a state.',
          truthState: 'fictional',
        },
      ],
      sources: [
        {
          sourceId: 'example-only-source',
          title: 'Authored fictional syntax fixture',
          url: 'https://fixture.invalid/writer-example',
          snapshotSha256: '0'.repeat(64),
          retrievedAt: '2026-10-20T00:00:00.000Z',
        },
      ],
      material: [],
      production: { kind: 'fixture', label: 'Authored fictional JSON syntax example; not generated product content' },
    };
    expect(compileGeneratedDraft(example, synthetic, true).kind).toBe('compiled');
    // Actual production evidence cannot authorize the example, even though its JSON/DSL is valid.
    expect(writerRole(provenance, true).outputSchema.safeParse(example).success).toBe(false);
    expect(
      claimsRole([page]).outputSchema.safeParse({
        candidateIds: ['example-only-claim', ...selection.candidateIds.slice(1)],
      }).success,
    ).toBe(false);
  });
  it('separates reference grammar from one real JSON exemplar within the unchanged token and prompt ceilings', () => {
    const role = writerRole(provenance, true);
    const json = writerDraftExampleJson();
    expect(role.instructions.split(json)).toHaveLength(2);
    expect(role.instructions).toContain(blockCatalogueText());
    expect(role.instructions.indexOf('SCHEMA REFERENCE GRAMMAR ONLY')).toBeLessThan(
      role.instructions.indexOf(blockCatalogueText()),
    );
    expect(role.instructions.indexOf('</schema-reference-grammar>')).toBeLessThan(role.instructions.indexOf(json));
    expect(role.instructions).toContain('No comments, trailing commas, ellipses');
    expect(role.instructions).toContain('NOT valid JSON to copy');
    expect(role.instructions).toContain('Do not copy its prose, IDs or claim ID');
    expect(role.instructions.length).toBeLessThanOrEqual(MAX_INSTRUCTION_CHARS);
    expect(Buffer.byteLength(role.instructions)).toBeLessThan(20_000);
    expect(role.maxOutputTokens).toBe(12_000);
    expect(claimsRole([page]).maxOutputTokens).toBe(4_000);
    expect(role.version).toBe(WRITER_PROMPT_VERSION);
    expect(claimsRole([page]).version).toBe(CLAIMS_ROLE_VERSION);
    expect(provenance.production).toMatchObject({ promptVersion: role.version });
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
