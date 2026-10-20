import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  type DraftProvenance,
  ScrollDraft,
  blockCatalogueText,
  normaliseDraftInput,
  REPAIR_HINTS,
} from '@knowscroll/scroll-model/producer';
import { extractResearch } from '../../../infrastructure/research/public-pages.js';
import { MAX_INSTRUCTION_CHARS } from '../../../reasoning/public.js';
import { MAX_ISSUES, validateOutput, validSafeCustomIssues } from '../../../reasoning/domain/output.js';
import { buildPrompt } from '../../../reasoning/domain/prompt.js';
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
  it('declares a bounded static writer catalogue admitted by the shared role contract; claims stay opted out', () => {
    const role = writerRole(provenance, false);
    expect(role.safeCustomIssues).toBeDefined();
    expect(validSafeCustomIssues(role.safeCustomIssues ?? {})).toBe(true);
    expect(role.safeCustomIssues).toMatchObject(REPAIR_HINTS);
    expect(Object.keys(role.safeCustomIssues ?? {}).length).toBe(Object.keys(REPAIR_HINTS).length + 3);
    expect(Object.isFrozen(role.safeCustomIssues)).toBe(true);
    expect(role.safeCustomIssues).not.toHaveProperty('admission_refused');
    expect(claimsRole([page]).safeCustomIssues).toBeUndefined();
    expect(claimsRole([page]).id).toBe('content.scroll-claims');
    expect(claimsRole([page]).version).toBe('scroll-claims.v2');
    expect(role.id).toBe('content.scroll-writer');
    expect(role.version).toBe('scroll-writer.v4');
  });

  it.each([
    ['copied_passage', sourceWords],
    ['number_unbound', 'An unexplained count is 99 today.'],
    ['reader_source_or_url', 'A publisher called NASA said this.'],
  ])('carries an actual writer %s refusal through masked fixed feedback into repair context', (code, text) => {
    const role = writerRole(provenance, false);
    const bad = fixtureDraft();
    const paragraph = bad.sections[0]?.blocks.find((block) => block.type === 'paragraph');
    if (paragraph?.type !== 'paragraph') throw new Error('CI_PARAGRAPH_MISSING');
    paragraph.data.spans = [{ text }];
    const result = validateOutput(role.outputSchema, bad, role.safeCustomIssues);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.reason).toBe('OUTPUT_SCHEMA_MISMATCH');
    expect(result.issues).toContainEqual(expect.objectContaining({ code, detail: role.safeCustomIssues?.[code] }));
    expect(result.issues.length).toBeLessThanOrEqual(MAX_ISSUES + 1);
    const repair = buildPrompt({
      roleId: role.id,
      roleVersion: role.version,
      instructions: role.instructions,
      bundleRef: 'ci-fixture-semantic-feedback',
      items: [],
      feedback: result.issues,
    });
    expect(repair.system).toContain(`${code} (${role.safeCustomIssues?.[code]})`);
    expect(repair.system).not.toContain(text);
    expect(JSON.stringify(result.issues)).not.toContain(text);
    expect(JSON.stringify(result.issues)).not.toContain(page.url);
    if (code === 'copied_passage' || code === 'number_unbound')
      expect(result.issues.some((issue) => issue.path.includes('?'))).toBe(true);
    // The same actual writer schema still suppresses semantic metadata without the explicit catalogue.
    const optedOut = validateOutput(role.outputSchema, bad);
    expect(optedOut.valid).toBe(false);
    if (!optedOut.valid)
      expect(optedOut.issues.every((issue) => issue.code === 'custom' && issue.detail === undefined)).toBe(true);
  });

  it('offers fixed feedback for production support and interactive requirements without accepting invalid drafts', () => {
    const missing = fixtureDraft();
    missing.bindings = [];
    for (const [role, value, code] of [
      [writerRole(provenance, false), missing, 'reader_block_unbound'],
      [writerRole(provenance, true), fixtureDraft(), 'interactive_required'],
    ] as const) {
      const verdict = validateOutput(role.outputSchema, value, role.safeCustomIssues);
      expect(verdict.valid).toBe(false);
      if (!verdict.valid)
        expect(verdict.issues).toContainEqual(expect.objectContaining({ code, detail: role.safeCustomIssues?.[code] }));
    }
  });

  it('keeps undeclared custom codes, reply-chosen paths and arbitrary messages out of writer feedback', () => {
    const role = writerRole(provenance, false);
    const privateText = 'WRITER-PRIVATE-UNDECLARED https://private.invalid/?Signature=fixture';
    const schema = role.outputSchema.superRefine((_draft, ctx) => {
      for (let index = 0; index < MAX_ISSUES + 2; index += 1)
        ctx.addIssue({
          code: 'custom',
          path: ['sections', 0, privateText],
          message: privateText,
          params: { safeCode: privateText },
        });
    });
    const verdict = validateOutput(schema, fixtureDraft(), role.safeCustomIssues);
    expect(verdict.valid).toBe(false);
    if (verdict.valid) return;
    expect(verdict.issues).toHaveLength(MAX_ISSUES + 1);
    expect(verdict.issues.slice(0, MAX_ISSUES)).toEqual(
      Array.from({ length: MAX_ISSUES }, () => ({ path: 'sections[0].?', code: 'custom' })),
    );
    expect(verdict.issues.at(-1)).toEqual({ path: '(root)', code: 'more', detail: '2 more' });
    expect(JSON.stringify(verdict.issues)).not.toContain(privateText);
  });
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
  it.each([false, true])(
    'embeds one valid fictional JSON draft for interactive=%s, authorized only by synthetic evidence',
    (interactive) => {
      const json = writerDraftExampleJson(interactive);
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
      expect(compileGeneratedDraft(example, synthetic, interactive).kind).toBe('compiled');
      // Actual production evidence cannot authorize the example, even though its JSON/DSL is valid.
      expect(writerRole(provenance, interactive).outputSchema.safeParse(example).success).toBe(false);
      expect(
        claimsRole([page]).outputSchema.safeParse({
          candidateIds: ['example-only-claim', ...selection.candidateIds.slice(1)],
        }).success,
      ).toBe(false);
    },
  );
  it.each([false, true])(
    'separates reference grammar from one mode-matched JSON exemplar for interactive=%s',
    (interactive) => {
      const role = writerRole(provenance, interactive);
      const json = writerDraftExampleJson(interactive);
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
      expect(role.instructions).toContain('finished 2–3 minute');
      expect(role.instructions).toContain('2–8 minute admission contract');
      expect(role.instructions).toContain('columns[].points is nested');
      const parsed = ScrollDraft.parse(JSON.parse(json));
      expect(parsed.sections[0]?.blocks[1]?.type).toBe(interactive ? 'diagram' : 'comparison');
      expect(role.instructions).not.toContain(writerDraftExampleJson(!interactive));
      expect(role.maxOutputTokens).toBe(12_000);
      expect(claimsRole([page]).maxOutputTokens).toBe(4_000);
      expect(role.version).toBe(WRITER_PROMPT_VERSION);
      expect(claimsRole([page]).version).toBe(CLAIMS_ROLE_VERSION);
      expect(provenance.production).toMatchObject({ promptVersion: role.version });
    },
  );
  it.each([false, true])(
    'admits a compact authored CI structure with a real computed 2–3 minute measure, interactive=%s',
    (interactive) => {
      // Existing editorial prose plus fictional format examples are structure fixtures, not generated teaching content.
      const paragraphs = fixtureDraft()
        .sections.flatMap((section) => section.blocks)
        .filter((block) => block.type === 'paragraph')
        .slice(0, 8);
      expect(paragraphs).toHaveLength(8);
      const groups = [
        paragraphs.slice(0, 2),
        paragraphs.slice(2, 3),
        paragraphs.slice(3, 4),
        paragraphs.slice(4, 5),
        paragraphs.slice(5, 6),
        paragraphs.slice(6, 8),
      ];
      const prose = groups.map((group, index) => ({
        id: `compact-paragraph-${index}`,
        type: 'paragraph' as const,
        data: { spans: [{ text: group.flatMap((block) => block.data.spans.map((span) => span.text)).join(' ') }] },
      }));
      const example = ScrollDraft.parse(JSON.parse(writerDraftExampleJson(interactive)));
      const formats = example.sections[0]?.blocks.slice(1) ?? [];
      const compact: ScrollDraft = {
        draftVersion: 'scroll-draft.v1',
        title: 'Authored compact structure fixture',
        dek: 'A labelled CI structure check combines existing authored prose and fictional format blocks.',
        sections: [
          { id: 'compact-opening', heading: null, blocks: prose.slice(0, 2) },
          {
            id: 'compact-mechanism',
            heading: 'Inspect the structure',
            blocks: [...prose.slice(2, 4), ...formats.slice(0, 1)],
          },
          {
            id: 'compact-limits',
            heading: 'Keep the limits visible',
            blocks: [...prose.slice(4), ...formats.slice(1)],
          },
        ],
        bindings: [...prose, ...formats].map((block) => ({
          kind: 'block',
          blockId: block.id ?? '',
          claimId: claims.claims[0]?.claimId ?? '',
        })),
      };
      const result = compileGeneratedDraft(compact, provenance, interactive);
      expect(result.kind).toBe('compiled');
      if (result.kind !== 'compiled') return;
      const measures = result.document['measures'] as { readingMinutes: number };
      expect(measures.readingMinutes).toBeGreaterThanOrEqual(2);
      expect(measures.readingMinutes).toBeLessThanOrEqual(3);
      expect(writerRole(provenance, interactive).outputSchema.safeParse(compact).success).toBe(true);
      const format = formats[0];
      if (format?.type === 'diagram') expect(format.data.interaction.kind).toBe('toggle');
    },
  );
  it('requires canonical rich-text arrays on the writer wire while leaving compiler normalization unchanged', () => {
    const single = fixtureDraft();
    const first = single.sections[0]?.blocks[0];
    if (first?.type !== 'paragraph') throw new Error('CI_PARAGRAPH_MISSING');
    const text = first.data.spans.map((span) => span.text).join('');
    const raw = JSON.parse(JSON.stringify(single)) as { sections: { blocks: { data: { spans: unknown } }[] }[] };
    const target = raw.sections[0]?.blocks[0];
    if (target === undefined) throw new Error('CI_PARAGRAPH_MISSING');
    target.data.spans = { text };
    const refused = writerRole(provenance, false).outputSchema.safeParse(raw);
    expect(refused.success).toBe(false);
    if (!refused.success)
      expect(refused.error.issues).toContainEqual(
        expect.objectContaining({ code: 'invalid_type', path: ['sections', 0, 'blocks', 0, 'data', 'spans'] }),
      );
    target.data.spans = text;
    expect(writerRole(provenance, false).outputSchema.safeParse(raw).success).toBe(false);
    expect(compileGeneratedDraft(raw, provenance, false).kind).toBe('compiled');
    const comparison = JSON.parse(writerDraftExampleJson(false)) as {
      sections: { blocks: { data: { columns?: { points: unknown[] }[] } }[] }[];
    };
    const column = comparison.sections[0]?.blocks[1]?.data.columns?.[0];
    if (column === undefined) throw new Error('CI_COMPARISON_MISSING');
    column.points[0] = { text: 'An invalid lone object instead of a point span array.' };
    expect(ScrollDraft.safeParse(comparison).success).toBe(false);
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
