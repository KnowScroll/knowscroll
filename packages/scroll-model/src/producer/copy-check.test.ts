/**
 * D-013: the copy check refuses any run of more than eight consecutive words from the research
 * material in ANY text a reader can see or hear: headings, captions, labels, units, accessibility
 * text, fallback text, alt text, transcripts, table cells, readouts and notices. Each case plants
 * a copied nine-word run in one field and expects the refusal to name that field.
 */
import { describe, expect, it } from 'vitest';
import { compileDraft, type DraftProvenance } from './index.js';
import { fixture } from '../test-support/fixtures.js';

const RUN = 'we saw an old red fox in a den';
const LONG = `${RUN} and then the day was over`;
const attention = fixture('attention-slowly');

type Json = Record<string, unknown>;

function setAt(root: unknown, path: string, value: unknown): void {
  const parts = path.split('.');
  let node = root as Json;
  for (const part of parts.slice(0, -1)) node = node[part] as Json;
  node[parts[parts.length - 1] ?? ''] = value;
}

function getAt(root: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, part) => (node as Json)[part], root);
}

function attempt(path: string, value: string, extra?: (draft: Json) => void) {
  const draft = structuredClone(attention.draft) as Json;
  extra?.(draft);
  setAt(draft, path, value);
  const provenance: DraftProvenance = {
    ...attention.provenance,
    material: [RUN],
    offeredMedia: [{ mediaId: 'med-1', revision: 1 }],
  };
  return compileDraft(draft, provenance);
}

/** The document paths the copy check refused after `value` was planted at `path`. */
function plant(path: string, value: string, extra?: (draft: Json) => void): readonly string[] {
  const outcome = attempt(path, value, extra);
  if (outcome.kind !== 'refused') return [];
  return outcome.issues.filter((issue) => issue.code === 'copied_passage').map((issue) => issue.path);
}

/** Fields of the committed attention draft (draft path = document path). */
const EXISTING: Array<[string, string, string]> = [
  ['the title', 'title', RUN],
  ['the dek', 'dek', LONG],
  ['a section heading', 'sections.1.heading', RUN],
  ['a diagram’s accessibility label', 'sections.0.blocks.2.a11y.label', RUN],
  ['a diagram’s accessibility description', 'sections.0.blocks.2.a11y.description', LONG],
  ['a diagram’s fallback text', 'sections.0.blocks.2.fallbackText', LONG],
  ['a diagram’s title', 'sections.0.blocks.2.data.title', RUN],
  ['a diagram’s instruction', 'sections.0.blocks.2.data.instruction', RUN],
  ['a diagram node’s label', 'sections.0.blocks.2.data.nodes.1.label', RUN],
  ['a diagram frame’s description', 'sections.0.blocks.2.data.frames.0.description', LONG],
  ['a chart’s title', 'sections.1.blocks.1.data.title', RUN],
  ['a chart’s caption', 'sections.1.blocks.1.data.caption', LONG],
  ['a chart’s scale label', 'sections.1.blocks.1.data.spec.scale.label', RUN],
  ['a chart’s accessibility description', 'sections.1.blocks.1.a11y.description', LONG],
  ['a simulation’s title', 'sections.1.blocks.2.data.title', RUN],
  ['a simulation’s prompt', 'sections.1.blocks.2.data.prompt', RUN],
  ['a parameter label', 'sections.1.blocks.2.data.params.0.label', RUN],
  ['a constant label', 'sections.1.blocks.2.data.constants.0.label', RUN],
  ['an output label', 'sections.1.blocks.2.data.outputs.0.label', RUN],
  ['a readout sentence', 'sections.1.blocks.2.data.readout.template', RUN],
  ['a readout band', 'sections.1.blocks.2.data.readout.bands.0.text', RUN],
  ['a simulation’s model note', 'sections.1.blocks.2.data.modelNote', RUN],
  ['a simulation’s accessibility description', 'sections.1.blocks.2.a11y.description', LONG],
  ['a disclosure’s summary', 'sections.1.blocks.3.data.summary', RUN],
  ['a code block’s title', 'sections.1.blocks.3.data.blocks.1.data.title', RUN],
  ['a code block’s fallback text', 'sections.1.blocks.3.data.blocks.1.fallbackText', LONG],
  ['a table’s caption', 'sections.2.blocks.1.data.caption', RUN],
  ['a table column’s label', 'sections.2.blocks.1.data.columns.0.label', RUN],
  ['a table cell', 'sections.2.blocks.1.data.rows.0.1', RUN],
  ['a table’s fallback text', 'sections.2.blocks.1.fallbackText', LONG],
  ['a callout’s text', 'sections.3.blocks.0.data.spans', `${RUN}.`],
];

/** Blocks the committed fixtures do not hold, appended after the last block of the last section. */
const APPENDED: Array<[string, string, Json]> = [
  [
    'a figure’s alt text',
    'sections.3.blocks.1.data.alt',
    {
      type: 'figure',
      a11y: { label: 'A picture' },
      fallbackText: `Text version of a picture, standing on its own for every reader.`,
      data: { media: { mediaId: 'med-1', revision: 1 }, motion: 'still', alt: LONG },
    },
  ],
  [
    'a figure’s caption',
    'sections.3.blocks.1.data.caption',
    {
      type: 'figure',
      a11y: { label: 'A picture' },
      fallbackText: `Text version of a picture, standing on its own for every reader.`,
      data: {
        media: { mediaId: 'med-1', revision: 1 },
        motion: 'still',
        alt: 'A quiet harbour at dawn',
        caption: LONG,
      },
    },
  ],
  [
    'a clip’s transcript',
    'sections.3.blocks.1.data.transcript',
    {
      type: 'media',
      a11y: { label: 'A clip' },
      fallbackText: `Text version of a clip, standing on its own for every reader.`,
      data: {
        kind: 'audio',
        media: { mediaId: 'med-1', revision: 1 },
        alt: 'A short audio clip',
        transcript: LONG,
        durationMs: 5_000,
      },
    },
  ],
  [
    'a clip’s alt text',
    'sections.3.blocks.1.data.alt',
    {
      type: 'media',
      a11y: { label: 'A clip' },
      fallbackText: `Text version of a clip, standing on its own for every reader.`,
      data: {
        kind: 'audio',
        media: { mediaId: 'med-1', revision: 1 },
        alt: LONG,
        transcript: 'Someone speaks for a short while.',
        durationMs: 5_000,
      },
    },
  ],
  [
    'a quotation’s attribution',
    'sections.3.blocks.1.data.attribution',
    { type: 'quote', data: { kind: 'quotation', spans: 'A short and plain remark.', attribution: RUN } },
  ],
  [
    'a list item',
    'sections.3.blocks.1.text',
    { type: 'list', data: { style: 'bullet', items: ['First plain item.', LONG] } },
  ],
  [
    'a timeline event’s title',
    'sections.3.blocks.1.data.events.1.title',
    {
      type: 'timeline',
      a11y: { label: 'A timeline' },
      fallbackText: `Text version of a timeline, standing on its own for every reader.`,
      data: {
        title: 'Some events',
        events: [
          { id: 'ev-one', when: 'First', title: 'Something began' },
          { id: 'ev-two', when: 'Later', title: RUN },
        ],
      },
    },
  ],
  [
    'a timeline event’s detail',
    'sections.3.blocks.1.data.events.0.detail',
    {
      type: 'timeline',
      a11y: { label: 'A timeline' },
      fallbackText: `Text version of a timeline, standing on its own for every reader.`,
      data: {
        title: 'Some events',
        events: [
          { id: 'ev-one', when: 'First', title: 'Something began', detail: LONG },
          { id: 'ev-two', when: 'Later', title: 'Something ended' },
        ],
      },
    },
  ],
  [
    'a comparison point',
    'sections.3.blocks.1.data.columns.1.points.0',
    {
      type: 'comparison',
      a11y: { label: 'A comparison' },
      fallbackText: `Text version of a comparison, standing on its own for every reader.`,
      data: {
        title: 'Two views',
        columns: [
          { label: 'One', points: ['A plain point.'] },
          { label: 'Two', points: [LONG] },
        ],
      },
    },
  ],
  [
    'a step’s text',
    'sections.3.blocks.1.data.steps.1.text',
    {
      type: 'sequence',
      a11y: { label: 'A sequence' },
      fallbackText: `Text version of a sequence, standing on its own for every reader.`,
      data: {
        title: 'Some steps',
        steps: [
          { id: 'step-one', title: 'First', spans: 'Do the first thing.' },
          { id: 'step-two', title: 'Second', spans: LONG },
        ],
      },
    },
  ],
  [
    'a step figure’s alt text',
    'sections.3.blocks.1.data.steps.0.figure.alt',
    {
      type: 'sequence',
      a11y: { label: 'A sequence' },
      fallbackText: `Text version of a sequence, standing on its own for every reader.`,
      data: {
        title: 'Some steps',
        steps: [
          {
            id: 'step-one',
            title: 'First',
            spans: 'Do the first thing.',
            figure: { media: { mediaId: 'med-1', revision: 1 }, alt: LONG },
          },
          { id: 'step-two', title: 'Second', spans: 'Do the second thing.' },
        ],
      },
    },
  ],
];

describe('the copy check covers every reader-facing text (D-013)', () => {
  it.each(EXISTING)('refuses a copied run in %s', (_name, path, value) => {
    const found = plant(path, value);
    // A text block’s passage text is addressed as `…text` and set through its spans.
    const wanted = path.endsWith('.data.spans') ? path.replace(/\.data\.spans$/u, '.text') : path;
    expect(found).toContain(wanted);
  });

  it.each(APPENDED)('refuses a copied run in %s', (_name, path, block) => {
    const wantedPath = path;
    const found = plant('title', 'A plain and honest title', (draft) => {
      const sections = draft['sections'] as Array<{ blocks: Json[] }>;
      sections[3]?.blocks.push({ id: 'zz-added', ...block });
    });
    // `plant` sets the title to something harmless; the copied run is inside the appended block.
    expect(found).toContain(wantedPath);
  });

  it('refuses a copied run in the kicker, which code takes from the brief', () => {
    const provenance: DraftProvenance = {
      ...attention.provenance,
      material: [RUN],
      publication: { ...attention.provenance.publication, kicker: RUN },
    };
    const outcome = compileDraft(attention.draft, provenance);
    expect(outcome.kind).toBe('refused');
    if (outcome.kind === 'refused') expect(outcome.issues).toContainEqual({ code: 'copied_passage', path: 'kicker' });
  });

  it('exempts only the body of a code block', () => {
    const body = 'sections.1.blocks.3.data.blocks.1.data.code';
    const original = getAt(attention.draft, body);
    if (typeof original !== 'string') throw new Error('fixture changed');
    expect(attempt(body, `# ${RUN}\n${original}`).kind).toBe('compiled');
  });

  it('refuses nothing when the run is eight words or fewer', () => {
    expect(attempt('sections.1.heading', 'we saw an old red fox in a').kind).toBe('compiled');
  });
});
