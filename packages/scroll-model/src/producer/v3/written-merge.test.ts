import { describe, expect, it } from 'vitest';
import type { IssueV3 } from '../../v3/issues.js';
import { mergeStagingV3, numberedProseText, stagingPathsV3 } from './written-merge.js';
import { WrittenProseV3, type WrittenStagingV3 } from './written-schema.js';

/** An invented two-section essay: paragraphs and a quotation, one aside. P1 and P2 are paragraphs, P3 a quotation, P4 a paragraph. */
function prose(): WrittenProseV3 {
  return {
    title: 'How a pond keeps its year',
    dek: 'A pond is a small thing, and it still keeps a whole year.',
    items: [
      { type: 'section', title: 'The warm half' },
      { type: 'para', text: 'A pond wakes in spring.', simple: 'A pond wakes up.', cites: ['e1'] },
      { type: 'para', text: 'Summer fills it with green.', simple: 'Summer is green.', cites: ['e1'] },
      { type: 'quote', text: 'The pond is full of light.', simple: 'Light fills it.', who: 'A. Writer', cites: ['e2'] },
      { type: 'aside', kind: 'limits', title: 'Where this stops', text: 'It leaves out the fish.', cites: ['e3'] },
      { type: 'section', title: 'The cold half' },
      { type: 'para', text: 'Autumn pulls the colour out.', simple: 'Autumn is pale.', cites: ['e3'] },
    ],
    takeaway: { text: 'A pond is a clock that tells the year.', cites: ['e1'] },
    askSuggestions: ['Why does a pond freeze from the top?'],
  };
}

function staging(stage: WrittenStagingV3['stage']): WrittenStagingV3 {
  return {
    pictures: [
      {
        kind: 'flow',
        title: 'A year',
        cites: ['e1'],
        steps: [{ label: 'Spring' }, { label: 'Summer' }],
      },
    ],
    stage,
  };
}

describe('numberedProseText', () => {
  it('numbers paragraphs and quotations P1 to Pn, and marks sections and asides without numbering them', () => {
    const lines = numberedProseText(prose()).split('\n');
    expect(lines).toEqual([
      'TITLE: How a pond keeps its year',
      'DEK: A pond is a small thing, and it still keeps a whole year.',
      'SECTION: The warm half',
      'P1 A pond wakes in spring.',
      'P2 Summer fills it with green.',
      'P3 (quotation, A. Writer) The pond is full of light.',
      'ASIDE (limits) Where this stops: It leaves out the fish.',
      'SECTION: The cold half',
      'P4 Autumn pulls the colour out.',
    ]);
  });

  it('shows no handle', () => {
    expect(numberedProseText(prose())).not.toMatch(/\be[0-9]\b/u);
  });
});

describe('mergeStagingV3', () => {
  it('applies each stage entry to its paragraph and keeps the prose word for word', () => {
    const { reply, issues, stageOfItem } = mergeStagingV3(
      prose(),
      staging([
        { para: 1, show: { picture: 1, upTo: 1 }, links: [{ phrase: 'spring', part: 'Spring' }] },
        {
          para: 4,
          show: { picture: 1 },
          control: { kind: 'scrub', label: 'Step', along: 'steps' },
          emphasis: 'turn',
        },
      ]),
    );
    expect(issues).toEqual([]);
    expect(reply.items[1]).toMatchObject({
      type: 'para',
      text: 'A pond wakes in spring.',
      show: { picture: 1, upTo: 1 },
    });
    expect(reply.items[2]).not.toHaveProperty('show');
    expect(reply.items[6]).toMatchObject({ type: 'para', control: { kind: 'scrub' } });
    expect(reply.items.map((item) => ('text' in item ? item.text : item.title))).toEqual(
      prose().items.map((item) => ('text' in item ? item.text : item.title)),
    );
    expect(reply.pictures).toHaveLength(1);
    expect([...stageOfItem]).toEqual([
      [1, 0],
      [6, 1],
    ]);
  });

  it('refuses a para that is not a paragraph, at its stage entry', () => {
    const { issues } = mergeStagingV3(prose(), staging([{ para: 1 }, { para: 5 }, { para: 9, show: { picture: 1 } }]));
    expect(issues).toEqual([
      { code: 'stage_para_unknown', path: 'stage.1.para' },
      { code: 'stage_para_unknown', path: 'stage.2.para' },
    ]);
  });

  it('refuses a para listed twice, and keeps the first entry', () => {
    const { issues, reply } = mergeStagingV3(
      prose(),
      staging([
        { para: 2, show: { picture: 1, upTo: 1 } },
        { para: 2, show: { picture: 1, upTo: 2 } },
      ]),
    );
    expect(issues).toEqual([{ code: 'stage_para_repeated', path: 'stage.1.para' }]);
    expect(reply.items[2]).toMatchObject({ show: { upTo: 1 } });
  });

  it('refuses a control on a quotation, at the control, and leaves it out; a show and links are fine there', () => {
    const { issues, reply } = mergeStagingV3(
      prose(),
      staging([{ para: 3, show: { picture: 1 }, control: { kind: 'pick', label: 'Pick' } }]),
    );
    expect(issues).toEqual([{ code: 'control_unfit', path: 'stage.0.control' }]);
    expect(reply.items[3]).toMatchObject({ type: 'quote', show: { picture: 1 } });
    expect(reply.items[3]).not.toHaveProperty('control');
  });

  it('refuses a stress on a quotation, which has none', () => {
    const { issues } = mergeStagingV3(prose(), staging([{ para: 3, emphasis: 'turn' }]));
    expect(issues).toEqual([{ code: 'schema_unrecognized_keys', path: 'stage.0.emphasis' }]);
  });
});

describe('stagingPathsV3', () => {
  const stageOfItem = new Map([[6, 1]]);

  it('reports what a paragraph shows, links, controls or stresses at its stage entry, and the list at stage', () => {
    const issues: IssueV3[] = [
      { code: 'show_state_invalid', path: 'items.6.show' },
      { code: 'link_part_unknown', path: 'items.6.links.0.part' },
      { code: 'control_unfit', path: 'items.6.control' },
      { code: 'main_text_too_long', path: 'items' },
      { code: 'picture_unshown', path: 'pictures.0' },
      { code: 'copied_passage', path: 'items.6' },
    ];
    expect(stagingPathsV3(issues, stageOfItem).map((issue) => issue.path)).toEqual([
      'stage.1.show',
      'stage.1.links.0.part',
      'stage.1.control',
      'stage',
      'pictures.0',
      'items.6',
    ]);
  });
});

describe('the reply schemas', () => {
  it('refuse a prose reply that carries a picture, a show, a link, a control or a stress', () => {
    const base = prose();
    expect(WrittenProseV3.safeParse(base).success).toBe(true);
    expect(WrittenProseV3.safeParse({ ...base, pictures: [] }).success).toBe(false);
    for (const extra of [
      { show: { picture: 1 } },
      { links: [] },
      { control: { kind: 'pick', label: 'x' } },
      { emphasis: 'turn' },
    ]) {
      const items = base.items.map((item) => (item.type === 'para' ? { ...item, ...extra } : item));
      expect(WrittenProseV3.safeParse({ ...base, items }).success).toBe(false);
    }
  });
});
