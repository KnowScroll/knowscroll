import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DraftProvenance,
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
import { TOPICS, explanationUnitFor, parseScrollTopic, SCROLL_PRODUCTION_VERSION } from './topics.js';
import { writerDraftExampleJson } from './writer-example.js';
import { writerDraftProfile } from './writer-profile.js';
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
function fixtureDraft(interactive = false) {
  const source = JSON.parse(
    readFileSync(new URL('../starter/why-the-sky-is-blue.editorial-scroll.json', import.meta.url), 'utf8'),
  ) as { draft: unknown };
  const draft = ScrollDraft.parse(normaliseDraftInput(source.draft));
  // Existing authored prose is filtered only for this CI profile fixture, never product content.
  draft.sections = draft.sections
    .map((section) => ({
      ...section,
      blocks: section.blocks.filter((block) => block.type === 'paragraph' || block.type === 'callout'),
    }))
    .filter((section) => section.blocks.length > 0);
  const format = ScrollDraft.parse(JSON.parse(writerDraftExampleJson(interactive))).sections[0]?.blocks[1];
  if (format === undefined) throw new Error('CI_FORMAT_MISSING');
  draft.sections[0]?.blocks.push(format);
  for (const section of draft.sections)
    for (const block of section.blocks)
      draft.bindings.push({ kind: 'block', blockId: block.id ?? '', claimId: claims.claims[0]?.claimId ?? '' });
  return draft;
}
describe('Scroll production roles (labelled CI fixture)', () => {
  it('hydrates only distinct offered IDs and rejects model-authored claim fields', () => {
    const role = claimsRole([page]);
    expect(role.outputFormat).toBe('single-tool-object');
    expect(role.nativeOutputSchema).toBe('zod-structural.v1');
    expect(role.instructions).toContain('native input of exactly one submit_output tool call');
    expect(role.outputSchema.safeParse({ candidateIds: selection.candidateIds.slice(0, 3) }).success).toBe(false);
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
  it('preserves general canonical grid admission and its cell checks while this writer selects flows', () => {
    const input = fixtureDraft(true);
    const format = input.sections.flatMap((section) => section.blocks).find((block) => block.type === 'diagram');
    if (!format) throw new Error('CI_DIAGRAM_MISSING');
    const original = format.data.nodes.map((node) => ({ ...node }));
    format.data.layout = 'grid';
    format.data.nodes = original.map((node, index) => ({ ...node, cell: { column: index, row: 0 } }));
    // Other producers keep valid grids; the shared compiler and stored admission are unchanged.
    expect(compileGeneratedDraft(input, provenance, true).kind).toBe('compiled');
    expect(writerRole(provenance, true).outputSchema.safeParse(input).success).toBe(false);
    for (const [layout, nodes] of [
      ['grid', original],
      ['grid', original.map((node) => ({ ...node, cell: { column: 0, row: 0 } }))],
      ['flow-lr', original.map((node, index) => ({ ...node, cell: { column: index, row: 0 } }))],
    ] as const) {
      format.data.layout = layout;
      format.data.nodes = [...nodes];
      const result = compileGeneratedDraft(input, provenance, true);
      expect(result.kind).toBe('refused');
      if (result.kind === 'refused')
        expect(result.issues).toContainEqual(expect.objectContaining({ code: 'diagram_cells_invalid' }));
      expect(writerRole(provenance, true).outputSchema.safeParse(input).success).toBe(false);
    }
    format.data.layout = 'flow-lr';
    format.data.nodes = original;
    expect(writerRole(provenance, true).outputSchema.safeParse(input).success).toBe(true);
  });
  it.each([false, true])(
    'embeds one valid fictional JSON draft for interactive=%s, authorized only by synthetic evidence',
    (interactive) => {
      const json = writerDraftExampleJson(interactive);
      const example: unknown = JSON.parse(json);
      expect(ScrollDraft.safeParse(example).success).toBe(true);
      expect(writerDraftProfile(interactive).safeParse(example).success).toBe(true);
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
      expect(role.instructions).not.toContain(blockCatalogueText());
      expect(role.instructions).toContain('SELECTED SCHEMA:');
      expect(role.instructions).toContain('INNER JSON GRAMMAR is the structural reference');
      expect(role.instructions).not.toContain('compiler convenience notation');
      expect(role.instructions).not.toContain('formula (closed kinds');
      expect(role.instructions).toContain('No comments, trailing commas, ellipses');
      expect(role.instructions).toContain('Do not copy its prose, IDs or claim ID');
      expect(role.instructions.length).toBeLessThanOrEqual(MAX_INSTRUCTION_CHARS);
      expect(Buffer.byteLength(role.instructions)).toBeLessThan(20_000);
      expect(role.instructions).toContain('finished 2–3 minute');
      expect(role.instructions).toContain('2–8 minute admission contract');
      expect(role.instructions.includes('columns[].points is nested')).toBe(!interactive);
      expect(role.instructions.includes('Use layout flow-lr and omit cell on every node')).toBe(interactive);
      const parsed = ScrollDraft.parse(JSON.parse(json));
      expect(parsed.sections[0]?.blocks[1]?.type).toBe(interactive ? 'diagram' : 'comparison');
      expect(role.instructions).not.toContain(writerDraftExampleJson(!interactive));
      expect(role.maxOutputTokens).toBe(12_000);
      expect(claimsRole([page]).maxOutputTokens).toBe(4_000);
      expect(role.version).toBe(WRITER_PROMPT_VERSION);
      expect(role.outputFormat).toBe('single-tool-json-string.v1');
      expect(role.nativeOutputSchema).toBe('zod-structural-json-string.v1');
      expect(role.instructions).toContain('exactly one submit_json_output_v1 tool call');
      expect(role.instructions).toContain('your own sentence structure and wording');
      expect(role.instructions).toContain('matching passage anchorText');
      expect(role.instructions).toContain('Never reproduce nine consecutive source words');
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
  it('clarifies complete native arrays and aggregate text bounds while keeping canonical schemas strict', () => {
    for (const interactive of [false, true]) {
      const role = writerRole(provenance, interactive);
      expect(role.version).toBe('scroll-writer.v11');
      expect(role.instructions).toContain('sections and bindings must be JSON arrays');
      expect(role.instructions).toContain('including repair, must regenerate the complete draft object');
      expect(role.instructions).toContain('Serialize only the complete object once');
      expect(role.instructions).not.toContain('submit_output input_schema');
      expect(role.instructions).toContain('String shorthand is not accepted');
      expect(role.instructions).toContain('1200 UTF-16 units for paragraphs and 600 for callouts');
      expect(role.safeCustomIssues).toHaveProperty('rich_text_too_long');
      expect(role.safeCustomIssues).toHaveProperty('rich_text_not_trimmed');
      const bad = fixtureDraft();
      const block = bad.sections[0]?.blocks.find((b) => b.type === 'paragraph');
      if (block?.type !== 'paragraph') throw new Error('CI_PARAGRAPH_MISSING');
      block.data.spans = [{ text: ' leading' }];
      const parsed = role.outputSchema.safeParse(bad);
      expect(parsed.success).toBe(false);
      if (!parsed.success)
        expect(parsed.error.issues).toContainEqual(
          expect.objectContaining({
            code: 'custom',
            params: { safeCode: 'rich_text_not_trimmed' },
          }),
        );
      expect(claimsRole([page]).version).toBe('scroll-claims.v4');
      expect(role.maxOutputTokens).toBe(12000);
    }
  });
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
  it.each([false, true])(
    'compiles omitted/explicit text passage projections without accepting invented JSON paths, interactive=%s',
    (interactive) => {
      const role = writerRole(provenance, interactive);
      expect(role.instructions).toContain('canonical projected prose field, NOT a JSON or schema path');
      expect(role.instructions).toContain('whole diagram or comparison');
      expect(role.instructions).toContain('actual supplied claim ID');
      for (const type of ['paragraph', 'callout'] as const) {
        for (const field of [undefined, 'text'] as const) {
          const value = fixtureDraft(interactive);
          const block = value.sections.flatMap((section) => section.blocks).find((block) => block.type === type);
          if (block?.type !== type) throw new Error('CI_PROSE_MISSING');
          const anchorText = block.data.spans
            .map((span) => span.text)
            .join('')
            .match(/^[^.!?]+[.!?]/u)?.[0];
          if (anchorText === undefined) throw new Error('CI_SENTENCE_MISSING');
          const binding = {
            kind: 'passage' as const,
            blockId: block.id ?? '',
            claimId: claims.claims[0]?.claimId ?? '',
            anchorText,
            ...(field === undefined ? {} : { field }),
          };
          value.bindings.push(binding);
          expect(role.outputSchema.safeParse(value).success).toBe(true);
          const compiled = compileGeneratedDraft(value, provenance, interactive);
          expect(compiled.kind).toBe('compiled');
          if (compiled.kind !== 'compiled') continue;
          expect(compiled.provenance['bindings']).toContainEqual(
            expect.objectContaining({ kind: 'passage', blockId: binding.blockId, field: 'text' }),
          );
          for (const invented of ['data.spans', 'data.spans.0.text', 'data.text', 'text.0']) {
            const invalid = { ...value, bindings: [...value.bindings.slice(0, -1), { ...binding, field: invented }] };
            expect(role.outputSchema.safeParse(invalid).success).toBe(false);
            const refused = compileGeneratedDraft(invalid, provenance, interactive);
            expect(refused.kind).toBe('refused');
            if (refused.kind === 'refused')
              expect(refused.issues).toContainEqual(expect.objectContaining({ code: 'binding_field_unknown' }));
          }
        }
      }
    },
  );
  it('puts copy, number, source-name and binding failures inside the same writer schema repair boundary', () => {
    const role = writerRole(provenance, false);
    expect(role.outputSchema.safeParse(fixtureDraft()).success).toBe(true);
    for (const [code, text] of [
      ['copied_passage', sourceWords],
      ['number_unbound', 'An unexplained count is 99 today.'],
      ['reader_source_or_url', 'A publisher called NASA said this.'],
    ] as const) {
      const draft = fixtureDraft();
      const block = draft.sections[0]?.blocks.find((b) => b.type === 'paragraph');
      if (block?.type !== 'paragraph') throw new Error('CI_PARAGRAPH_MISSING');
      block.data.spans = [{ text }];
      const parsed = role.outputSchema.safeParse(draft);
      expect(parsed.success).toBe(false);
      if (!parsed.success)
        expect(parsed.error.issues).toContainEqual(
          expect.objectContaining({ code: 'custom', params: { safeCode: code } }),
        );
    }
    const missing = fixtureDraft();
    missing.bindings = [];
    const parsed = role.outputSchema.safeParse(missing);
    expect(parsed.success).toBe(false);
    if (!parsed.success)
      expect(parsed.error.issues).toContainEqual(
        expect.objectContaining({ code: 'custom', params: { safeCode: 'reader_block_unbound' } }),
      );
  });
});

describe('code-owned explanation recipes (source declarations, not generated semantic coverage)', () => {
  it('preserves every original recipe value and exact Reel explanation identity', () => {
    expect(TOPICS.seasons).toMatchObject({
      script: 'seasons-v5',
      topicId: 'earth.seasons',
      assetId: 'af2628f1-98a7-4c39-9f81-628506d247a1',
      explanationUnitId: 'legacy-cutroom-seasons-v5',
      interactive: true,
      brief:
        'Why Earth has seasons: axial tilt changes daylight and sunlight angle; distance is not the cause. Include a useful interactive diagram with frames for opposite hemispheres. Explain the limits of the simplified picture.',
      pages: ['https://spaceplace.nasa.gov/seasons/en/'],
    });
    expect(TOPICS.tides).toMatchObject({
      script: 'tides-v4',
      topicId: 'earth.tides',
      assetId: '8349204a-0c98-45d3-a354-6c73be4a86de',
      explanationUnitId: 'legacy-cutroom-tides-v4',
      interactive: true,
      brief:
        'How the Moon and Sun make tides: differential gravity, both tidal bulges, spring and neap alignment, real coastlines. Include an interactive diagram. Avoid implying the far bulge is a pile of water pulled through Earth or that every coast has the same timing.',
      pages: [
        'https://oceanservice.noaa.gov/education/tutorial_tides/tides03_gravity.html',
        'https://oceanservice.noaa.gov/education/tutorial_tides/tides06_variations.html',
      ],
    });
    expect(TOPICS.greenhouse).toMatchObject({
      script: 'greenhouse',
      topicId: 'earth.greenhouse-effect',
      assetId: 'a73a7732-a154-4c10-aa6f-169fa10cd8aa',
      explanationUnitId: 'legacy-cutroom-greenhouse',
      interactive: false,
      brief:
        'The greenhouse effect, a blanket made of gas: sunlight heats the surface; infrared absorption and emission slow cooling to space; the surface warms until energy balances. The blanket is an analogy, gases do not create energy or act as a solid lid. Distinguish the natural effect from strengthening it. Use comparison or disclosure.',
      pages: ['https://science.nasa.gov/climate-change/faq/what-is-the-greenhouse-effect/'],
    });
    for (const topic of ['seasons', 'tides', 'greenhouse'] as const)
      expect(explanationUnitFor(topic)).toBe(TOPICS[topic].explanationUnitId);
  });
  it('declares three independent same-subtopic units and two required interactive explanations', () => {
    const keys = ['greenhouse-radiation', 'greenhouse-balance', 'greenhouse-limits'] as const;
    const units = keys.map((key) => TOPICS[key]);
    expect(SCROLL_PRODUCTION_VERSION).toBe('scroll-production.v13');
    expect(units.map(({ interactive }) => interactive)).toEqual([true, true, false]);
    expect(units.every(({ topicId }) => topicId === 'earth.greenhouse-effect')).toBe(true);
    expect(new Set(Object.values(TOPICS).map(({ assetId }) => assetId)).size).toBe(Object.keys(TOPICS).length);
    expect(new Set(Object.values(TOPICS).map(({ explanationUnitId }) => explanationUnitId)).size).toBe(
      Object.keys(TOPICS).length,
    );
    for (const key of keys) {
      expect(parseScrollTopic(key)).toBe(key);
      expect(explanationUnitFor(key)).not.toMatch(/^legacy-cutroom-/u);
      expect(TOPICS[key].pages).not.toContain('https://science.nasa.gov/climate-change/causes/');
    }
    // These are distinct intended teaching tasks, not an assertion about ungenerated prose.
    expect(TOPICS['greenhouse-radiation'].brief).toContain('selectable process frames');
    expect(TOPICS['greenhouse-balance'].brief).toContain('redistribution inside the system');
    expect(TOPICS['greenhouse-limits'].brief).toContain('useful comparison versus misleading inference');
    expect(TOPICS['greenhouse-radiation'].pages).toEqual(TOPICS['greenhouse-limits'].pages);
    expect(TOPICS['greenhouse-balance'].pages).not.toEqual(TOPICS['greenhouse-radiation'].pages);
    for (const topic of Object.keys(TOPICS) as (keyof typeof TOPICS)[]) {
      const declared = generatedProvenance({
        topic,
        runId: 'fixture-writer-run',
        attemptIds: ['fixture-attempt'],
        model: 'CI-fixture-only',
        claims,
        pages: [page],
      });
      expect(DraftProvenance.safeParse(declared).success, topic).toBe(true);
    }
    for (const raw of [
      undefined,
      '',
      'GREENHOUSE',
      'greenhouse ',
      'greenhouse-radiation-extra',
      '__proto__',
      'constructor',
      'x'.repeat(10000),
    ])
      expect(parseScrollTopic(raw)).toBeUndefined();
  });
});
