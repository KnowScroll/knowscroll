import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  fallbackTextOf,
  numericTokens,
  REASON_CODES,
  simulationNumbers,
  validateDocument,
  walkBlocks,
  type ScrollDocument,
} from '../index.js';
import { addressedTexts } from '../internal/honesty.js';
import type { ProvenanceBinding } from '../internal/index.js';
import { sentenceRanges } from '../text.js';
import { scrollDocument } from '../test-support/arbitraries.js';
import { fixture } from '../test-support/fixtures.js';
import {
  compileDraft,
  draftFromDocument,
  normaliseDraftInput,
  REPAIR_HINTS,
  repairItems,
  ScrollDraft,
  scrollDraftJsonSchema,
  stageOf,
  validateDraft,
  type DraftProvenance,
} from './index.js';

type Mutable = Record<string, unknown> & {
  sections: Array<{ blocks: Array<Record<string, unknown> & { data: Record<string, unknown> }> }>;
};

const attention = fixture('attention-slowly');
const draft = () => structuredClone(attention.draft) as Mutable;
const refusal = (raw: unknown, provenance: DraftProvenance = attention.provenance) => {
  const outcome = validateDraft(raw, provenance);
  return outcome.kind === 'refused' ? { stage: outcome.stage, codes: outcome.issues.map((issue) => issue.code) } : null;
};

describe('validateDraft: staged checks with stable reason codes', () => {
  it('accepts the fixture drafts', () => {
    for (const name of ['attention-slowly', 'weight-other-worlds', 'spring-neap-tides'] as const) {
      const item = fixture(name);
      expect(validateDraft(item.draft, item.provenance).kind, name).toBe('valid');
    }
  });

  it('refuses at the first failing stage, with its code', () => {
    const cases: Array<[string, string, (value: Mutable) => unknown]> = [
      ['envelope', 'draft_not_object', () => 'not an object'],
      ['envelope', 'draft_version_unknown', (value) => ({ ...value, draftVersion: 'scroll-draft.v2' })],
      ['envelope', 'draft_too_large', (value) => ({ ...value, padding: 'x'.repeat(300_000) })],
      [
        'envelope',
        'fallback_reserved',
        (value) => {
          const block = value.sections[0]?.blocks[0];
          if (block !== undefined) block['type'] = 'fallback';
          return value;
        },
      ],
      [
        'envelope',
        'block_type_unknown',
        (value) => {
          const block = value.sections[0]?.blocks[0];
          if (block !== undefined) block['type'] = 'hologram';
          return value;
        },
      ],
      ['schema', 'schema_unrecognized_keys', (value) => ({ ...value, readingMinutes: 4 })],
      [
        'schema',
        'schema_unrecognized_keys',
        (value) => {
          const block = value.sections[0]?.blocks[2];
          if (block !== undefined) block['gesture'] = 'none';
          return value;
        },
      ],
      [
        'schema',
        'text_mentions_web_address',
        (value) => {
          const block = value.sections[0]?.blocks[1];
          if (block !== undefined) block.data['spans'] = 'Read more at science.nasa.gov tonight.';
          return value;
        },
      ],
      [
        'structure',
        'a11y_missing',
        (value) => {
          const block = value.sections[0]?.blocks[2];
          if (block !== undefined) delete block['a11y'];
          return value;
        },
      ],
      [
        'structure',
        'fallback_text_missing',
        (value) => {
          const block = value.sections[0]?.blocks[2];
          if (block !== undefined) delete block['fallbackText'];
          return value;
        },
      ],
      [
        'structure',
        'id_duplicate',
        (value) => {
          const block = value.sections[0]?.blocks[1];
          if (block !== undefined) block['id'] = 'crowd-p1';
          return value;
        },
      ],
      [
        'computation',
        'sim_param_default',
        (value) => {
          const sim = value.sections[1]?.blocks[2];
          const params = sim?.data['params'] as Array<Record<string, unknown>> | undefined;
          if (params?.[0] !== undefined) params[0]['default'] = 600;
          return value;
        },
      ],
      [
        'evidence',
        'number_unbound',
        (value) => ({
          ...value,
          bindings: (value['bindings'] as Array<{ blockId: string }>).filter(
            (binding) => binding.blockId !== 'squared-p1',
          ),
        }),
      ],
      [
        'evidence',
        'binding_anchor_not_found',
        (value) => ({
          ...value,
          bindings: [
            ...(value['bindings'] as unknown[]),
            { kind: 'passage', claimId: 'clm-attn-softmax', blockId: 'crowd-p1', anchorText: 'not in the text' },
          ],
        }),
      ],
      [
        'evidence',
        'binding_anchor_ambiguous',
        (value) => ({
          ...value,
          bindings: [
            ...(value['bindings'] as unknown[]),
            { kind: 'passage', claimId: 'clm-attn-softmax', blockId: 'crowd-p1', anchorText: 'the' },
          ],
        }),
      ],
      [
        'evidence',
        'binding_claim_unknown',
        (value) => ({
          ...value,
          bindings: [
            ...(value['bindings'] as unknown[]),
            { kind: 'block', claimId: 'clm-invented', blockId: 'crowd-p1' },
          ],
        }),
      ],
      [
        'evidence',
        'simulation_number_unbound',
        (value) => {
          const sim = value.sections[1]?.blocks[2];
          if (sim !== undefined) sim.data['illustrative'] = false;
          return value;
        },
      ],
      [
        'evidence',
        'binding_value_unknown',
        (value) => ({
          ...value,
          bindings: [
            ...(value['bindings'] as unknown[]),
            { kind: 'value', claimId: 'clm-attn-quadratic', blockId: 'length-sim', path: 'params.9.max' },
          ],
        }),
      ],
      [
        'evidence',
        'binding_anchor_crosses_sentence',
        (value) => ({
          ...value,
          bindings: [
            ...(value['bindings'] as unknown[]),
            {
              kind: 'passage',
              claimId: 'clm-attn-quadratic',
              blockId: 'squared-p1',
              anchorText: 'comparisons. Twelve',
            },
          ],
        }),
      ],
      [
        'evidence',
        'binding_field_unknown',
        (value) => ({
          ...value,
          bindings: [
            ...(value['bindings'] as unknown[]),
            {
              kind: 'passage',
              claimId: 'clm-attn-quadratic',
              blockId: 'attention-code',
              field: 'data.code',
              anchorText: 'scores',
            },
          ],
        }),
      ],
      [
        'schema',
        'schema_unrecognized_keys',
        (value) => {
          const paragraph = value.sections[0]?.blocks[0];
          if (paragraph !== undefined) paragraph['fallbackText'] = 'Text blocks never carry their own fallback text.';
          return value;
        },
      ],
      [
        'evidence',
        'constant_unbound',
        (value) => {
          const sim = value.sections[1]?.blocks[2];
          if (sim !== undefined) sim.data['illustrative'] = false;
          return value;
        },
      ],
      [
        'evidence',
        'media_not_offered',
        (value) => {
          value.sections[0]?.blocks.push({
            id: 'harbour',
            type: 'figure',
            a11y: { label: 'Harbour' },
            fallbackText: 'Text version: a quiet harbour at dawn with two boats.',
            data: {
              media: { mediaId: 'med-unoffered', revision: 1 },
              motion: 'still',
              alt: 'A quiet harbour at dawn.',
            },
          });
          return value;
        },
      ],
    ];
    for (const [stage, code, change] of cases) {
      expect(refusal(change(draft())), code).toMatchObject({ stage, codes: expect.arrayContaining([code]) as unknown });
    }
  });

  it('refuses copied runs of nine or more words from the evidence', () => {
    const provenance: DraftProvenance = {
      ...attention.provenance,
      material: ['You knew at once that the animal was too tired to cross the busy street at noon.'],
    };
    const value = draft();
    const block = value.sections[0]?.blocks[3];
    if (block !== undefined)
      block.data['spans'] = 'You knew at once that the animal was too tired to cross. Then think again.';
    expect(refusal(value, provenance)).toEqual({ stage: 'evidence', codes: ['copied_passage'] });
  });

  it('refuses a draft whose length does not fit the brief', () => {
    const provenance: DraftProvenance = {
      ...attention.provenance,
      publication: { ...attention.provenance.publication, targetMinutes: [5, 8] },
    };
    expect(refusal(draft(), provenance)).toEqual({ stage: 'brief', codes: ['reading_length_out_of_brief'] });
  });

  it('maps every reason code to a stage and a fixed repair hint', () => {
    for (const code of REASON_CODES) {
      expect(typeof REPAIR_HINTS[code]).toBe('string');
      expect(['envelope', 'schema', 'structure', 'computation', 'evidence', 'brief', 'publish']).toContain(
        stageOf(code),
      );
    }
    const items = repairItems(Array.from({ length: 40 }, () => ({ code: 'id_duplicate' as const, path: '$' })));
    expect(items).toHaveLength(32);
    expect(items[0]).toEqual({ code: 'id_duplicate', path: '$', hint: REPAIR_HINTS.id_duplicate });
  });
});

describe('compileDraft: code, not the model, sets derived fields', () => {
  it('is deterministic', () => {
    const first = compileDraft(attention.draft, attention.provenance);
    const second = compileDraft(structuredClone(attention.draft), structuredClone(attention.provenance));
    expect(canonicalJson(second)).toBe(canonicalJson(first));
  });

  it('assigns ids that are missing, without colliding with ids the model chose', () => {
    const value = draft();
    const blocks = value.sections[2]?.blocks ?? [];
    delete blocks[1]?.['id'];
    blocks.push({ type: 'paragraph', data: { spans: 'Another plain sentence for the end of this section.' } });
    const outcome = compileDraft(value, attention.provenance);
    if (outcome.kind !== 'compiled') throw new Error(JSON.stringify(outcome));
    const ids = outcome.document.sections[2]?.blocks.map((block) => block.id);
    expect(ids).toEqual(['weights-p1', 'table-1', 'paragraph-1']);
  });

  it('derives text blocks\u2019 accessibility label, and stores no fallback text for them', () => {
    const outcome = compileDraft(attention.draft, attention.provenance);
    if (outcome.kind !== 'compiled') throw new Error(JSON.stringify(outcome));
    const callout = outcome.document.sections[3]?.blocks[0];
    expect(callout?.a11y).toEqual({ label: 'Limits' });
    expect(callout !== undefined && 'fallbackText' in callout).toBe(false);
    if (callout !== undefined) expect(fallbackTextOf(callout)).toMatch(/^Attention shows which words/u);
    const value = draft();
    const block = value.sections[3]?.blocks[0];
    if (block !== undefined) block['a11y'] = { label: 'Whatever the model said' };
    expect(refusal(value)).toMatchObject({ stage: 'schema', codes: ['schema_unrecognized_keys'] });
  });

  it('copies framing, template, theme and identity from the provenance, never from the draft', () => {
    const provenance: DraftProvenance = {
      ...attention.provenance,
      publication: {
        ...attention.provenance.publication,
        framing: { kind: 'hypothetical', assumptions: ['Every sentence were twice as long'], kept: ['The same model'] },
        template: 'editorial',
        revision: 3,
      },
    };
    const outcome = compileDraft(attention.draft, provenance);
    if (outcome.kind !== 'compiled') throw new Error(JSON.stringify(outcome));
    expect(outcome.document).toMatchObject({
      framing: provenance.publication.framing,
      template: 'editorial',
      revision: 3,
    });
    expect(outcome.internalProvenance.revision).toBe(3);
    expect(outcome.internalProvenance.documentSha256).toBe(outcome.document.integrity.sha256);
  });

  it('records only the claims the draft relies on, their sources and every stage that passed', () => {
    const outcome = compileDraft(attention.draft, attention.provenance);
    if (outcome.kind !== 'compiled') throw new Error(JSON.stringify(outcome));
    expect(outcome.internalProvenance.checks.map((check) => check.name)).toEqual([
      'envelope',
      'schema',
      'structure',
      'computation',
      'evidence',
      'brief',
      'publish',
    ]);
    const bound = new Set(outcome.internalProvenance.bindings.map((binding) => binding.claimId));
    expect(outcome.internalProvenance.claims.map((claim) => claim.claimId).every((id) => bound.has(id))).toBe(true);
  });

  it('is idempotent for generated documents: compiling draftFromDocument of the output returns the output', () => {
    fc.assert(
      fc.property(scrollDocument(3, 5), (generated) => {
        const { provenance, bindings } = evidenceFor(generated);
        const first = compileDraft(draftFromDocument(generated, bindings), provenance);
        expect(first.kind, JSON.stringify(first.kind === 'refused' ? first : null)).toBe('compiled');
        if (first.kind !== 'compiled') return;
        expect(validateDocument(first.document).kind).toBe('valid');
        const second = compileDraft(draftFromDocument(first.document, first.internalProvenance.bindings), provenance);
        if (second.kind !== 'compiled') throw new Error(JSON.stringify(second));
        expect(canonicalJson(second.document)).toBe(canonicalJson(first.document));
        expect(second.internalProvenance).toEqual(first.internalProvenance);
      }),
      { numRuns: 40 },
    );
  });
});

/**
 * Binds every number of a generated document to one generic claim — an anchor on each numeric
 * token, a value or constant binding for each simulation number, a block binding for each chart —
 * and offers every media reference used.
 */
function evidenceFor(document: ScrollDocument): { provenance: DraftProvenance; bindings: ProvenanceBinding[] } {
  const claimId = 'clm-generic';
  const bindings: ProvenanceBinding[] = [];
  const media = new Map<string, { mediaId: string; revision: number }>();
  for (const entry of addressedTexts(document)) {
    if (entry.code) continue;
    for (const [start, end] of numericTokens(entry.text)) {
      const sentence = sentenceRanges(entry.text).find(([from, to]) => from <= start && end <= to) ?? [start, end];
      const token = entry.text.slice(start, end);
      const unique = entry.text.indexOf(token) === entry.text.lastIndexOf(token);
      const [from, to] = unique ? [start, end] : sentence;
      const [scope, id, ...rest] = entry.address.split(':');
      if (scope === 'header')
        bindings.push({ kind: 'header', claimId, field: id as 'title' | 'dek' | 'kicker', start: from, end: to });
      else if (scope === 'heading')
        bindings.push({ kind: 'heading', claimId, sectionId: id ?? '', start: from, end: to });
      else bindings.push({ kind: 'passage', claimId, blockId: id ?? '', field: rest.join(':'), start: from, end: to });
    }
  }
  for (const { block } of walkBlocks(document.sections)) {
    if (block.type === 'chart') bindings.push({ kind: 'block', claimId, blockId: block.id });
    if (block.type === 'simulation') {
      bindings.push({ kind: 'block', claimId, blockId: block.id });
      for (const number of simulationNumbers(block.data)) {
        bindings.push(
          number.constantKey === undefined
            ? { kind: 'value', claimId, blockId: block.id, path: number.path }
            : { kind: 'constant', claimId, blockId: block.id, constantKey: number.constantKey },
        );
      }
    }
    const refs =
      block.type === 'figure'
        ? [block.data.media]
        : block.type === 'media'
          ? [block.data.media, block.data.poster, block.data.captions].filter((ref) => ref !== undefined)
          : block.type === 'sequence'
            ? block.data.steps.flatMap((step) => (step.figure === undefined ? [] : [step.figure.media]))
            : [];
    for (const ref of refs) media.set(`${ref.mediaId}@${ref.revision}`, ref);
  }
  return {
    bindings,
    provenance: {
      schemaVersion: 'scroll-draft-provenance.v1',
      publication: {
        assetId: document.assetId,
        revision: document.revision,
        language: document.language,
        explanationUnitId: document.explanationUnitId,
        template: document.template,
        theme: document.theme,
        kicker: document.kicker,
        framing: document.framing,
        corrections: document.corrections,
      },
      claims: [
        {
          claimId,
          statement: 'A generic fixture claim.',
          quote: 'Generic fixture quote.',
          sourceId: 'src-generic',
          truthState: 'documented',
        },
      ],
      sources: [
        {
          sourceId: 'src-generic',
          title: 'Generic fixture source',
          url: 'https://fixture.invalid/generic',
          snapshotSha256: 'f16d05ec6b29248d2c61adb1e9263f78e4f7bace1b955014a2d17872cfe4064d',
          retrievedAt: '2026-10-19T00:00:00Z',
        },
      ],
      material: [],
      offeredMedia: [...media.values()],
      production: { kind: 'fixture', label: 'generated by a property test' },
    },
  };
}

describe('the producer contract', () => {
  it('exports a JSON Schema of the draft for constrained decoding', () => {
    const schema = scrollDraftJsonSchema();
    expect(schema['type']).toBe('object');
    expect(JSON.stringify(schema)).toContain('scroll-draft.v1');
    expect(ScrollDraft.safeParse(normaliseDraftInput(attention.draft)).success).toBe(true);
  });
});
