import { describe, expect, it } from 'vitest';
import {
  authoredV2,
  compileInputV2,
  EVIDENCE_V2,
  filler,
  PASSAGES_V2,
  recipeV2,
} from '../../test-support/v2-fixtures.js';
import { isSortRight, sortedItems, type InteractiveKind } from '../../v2/blocks.js';
import type { ScrollDocumentV2 } from '../../v2/document.js';
import { validateDocumentV2 } from '../../v2/validate.js';
import { AuthoredScrollV2 } from './authoring-schema.js';
import { compileAuthoredV2, type CompileV2Input } from './compile.js';
import { authoringReferenceV2 } from './reference.js';

/** CI fixtures: an invented planet, and two more passages that state figures a scale and a chart may use. */
/** Every way a passage writes 1.5 times a power of ten (D-208). The figure alone would read as 1.5. */
const POWER_FORMS = ['×10−7', ' × 10^7', 'x10⁷', '·10-7', '*10^7', 'e-7', 'E+30', ' × 10⁻⁷', ' x 10^-7'];
const FIGURE_PASSAGES = [
  ...PASSAGES_V2,
  'Orrin circles Vael at 150 million kilometres, its moon Pell at 228 million, and the ice giant Sarn at 779 million kilometres.',
  'Doubling the work on Orrin ferries takes 100 trips for 10 crates, 10,000 trips for 100 crates and 1,000,000 trips for 1,000 crates.',
  'The people of Orrin numbered 8.3\u00a0million in the year 1801, 17 million in 1850 and 31 million in 1901, while 17 sheep grazed on one hill.',
  // Other ways a passage writes a figure (D-208).
  'About 1,400 million people live along the Vael river, and the 1,400 million keep growing.',
  'Pell holds 8.3m moons of dust, 4.1bn grains of sand and 7.5 crore stones.',
  'The crowd of 8.3-million cheered, and the harbour holds 9-million barrels.',
  'Between 8 to 10 million pilgrims come each year, and 20\u201330 million visit in all.',
  ...POWER_FORMS.map((form) => `One grain of Orrin dust weighs 1.5${form} grams.`),
];
const evidence = (): CompileV2Input['evidence'] => ({
  claimIdOf: new Map([
    ...EVIDENCE_V2.claimIdOf,
    ...FIGURE_PASSAGES.slice(6).map((_, index): [string, string] => [
      `e${String(index + 7)}`,
      `claim-v2-${String(index + 7)}`,
    ]),
  ]),
  quoteOf: new Map([
    ...EVIDENCE_V2.quoteOf,
    ...FIGURE_PASSAGES.slice(6).map((text, index): [string, string] => [`claim-v2-${String(index + 7)}`, text]),
  ]),
  minDistinctCitations: 4,
});

type Mutable = { items: Record<string, unknown>[]; [key: string]: unknown };

/** The plain fixture with item `at` made into a play block, and the recipe naming the blocks. */
function withBlock(
  at: number,
  block: Record<string, unknown>,
  blocks: readonly InteractiveKind[],
  edit: (draft: Mutable) => void = () => undefined,
  guide?: 'ray',
  revision = 1,
) {
  const draft = JSON.parse(JSON.stringify(authoredV2('plain'))) as Mutable;
  draft.items[at] = { ...draft.items[at], ...block };
  edit(draft);
  const base = compileInputV2('plain');
  const input: CompileV2Input = {
    ...base,
    publication: { ...base.publication, revision },
    recipe: { ...recipeV2('plain'), blocks, ...(guide === undefined ? {} : { guide }) },
    evidence: evidence(),
    sources: FIGURE_PASSAGES,
  };
  return compileAuthoredV2(AuthoredScrollV2.parse(draft), input);
}

const SORT = {
  type: 'sort',
  cites: ['e2', 'e3'],
  items: ['The lean points toward Vael', 'Sunlight arrives steeply', 'Days run long', 'The northern half warms'],
  explain: 'Each step follows from the one before it.',
};
const SCALE = {
  type: 'scale',
  cites: ['e7'],
  axis: 'linear',
  unit: 'kilometres',
  points: [
    { label: 'Sarn', value: '779', magnitude: 'million' },
    { label: 'Orrin', value: '150', magnitude: 'million' },
    { label: 'Pell', value: '228', magnitude: 'million' },
  ],
  here: 'Orrin',
};
const CHART = {
  type: 'chart',
  cites: ['e8'],
  shape: 'bars',
  unit: 'trips',
  points: [
    { label: 'Ten crates', value: '100' },
    { label: 'A hundred crates', value: '10,000' },
    { label: 'A thousand crates', value: 1000000 },
  ],
};
const FORK = {
  type: 'fork',
  cites: ['e2', 'e3'],
  prompt: 'Which half do you want to follow?',
  branches: [
    { label: 'The north', text: 'The northern half warms when its lean points toward Vael.' },
    { label: 'The south', text: 'The southern half cools at the same time, for the same reason.' },
  ],
};

type Outcome = ReturnType<typeof withBlock>;
const codesOf = (outcome: Outcome) =>
  outcome.kind === 'refused' ? outcome.issues.map((issue) => `${issue.code}@${issue.path}`) : [];
const documentOf = (outcome: Outcome): ScrollDocumentV2 => {
  if (outcome.kind !== 'compiled') throw new Error(`refused: ${JSON.stringify(codesOf(outcome))}`);
  return outcome.document;
};
const interactiveOf = (outcome: Outcome, at = 2) => {
  const stop = documentOf(outcome).stops[at];
  if (stop?.kind !== 'read' || stop.interactive === undefined) throw new Error('a stop with a play block');
  return stop.interactive;
};

describe('a sort', () => {
  const outcome = withBlock(2, SORT, ['sort']);

  it('compiles, and admission accepts the document', () => {
    const document = documentOf(outcome);
    expect(validateDocumentV2(JSON.parse(JSON.stringify(document))).kind).toBe('valid');
  });

  it('keeps the writer’s order as the answer and shows the items shuffled, never already in order', () => {
    const sort = interactiveOf(outcome);
    if (sort.type !== 'sort') throw new Error('a sort');
    expect(sortedItems(sort)).toEqual(SORT.items);
    expect(sort.items).not.toEqual(SORT.items);
    expect(isSortRight(sort, sort.order)).toBe(true);
    expect(isSortRight(sort, [...sort.order].reverse())).toBe(false);
  });

  it('is deterministic', () => {
    expect(JSON.stringify(withBlock(2, SORT, ['sort']))).toBe(JSON.stringify(outcome));
  });

  it('is never shown in the right order, even for a seed that would shuffle to it', () => {
    const three = { ...SORT, items: SORT.items.slice(0, 3) };
    for (let revision = 1; revision <= 60; revision += 1) {
      const sort = interactiveOf(withBlock(2, three, ['sort'], undefined, undefined, revision));
      if (sort.type !== 'sort') throw new Error('a sort');
      expect(sort.items).not.toEqual(three.items);
      expect(sortedItems(sort)).toEqual(three.items);
    }
  });

  it('refuses two equal items', () => {
    const duplicated = withBlock(2, { ...SORT, items: [SORT.items[0], SORT.items[0], SORT.items[2]] }, ['sort']);
    expect(codesOf(duplicated)).toContain('sort_items_duplicate@items.2');
  });
});

describe('a scale', () => {
  it('sorts the points by value, finds "you are here" and compiles', () => {
    const scale = interactiveOf(withBlock(2, SCALE, ['scale']));
    if (scale.type !== 'scale') throw new Error('a scale');
    expect(scale.points.map((point) => point.value)).toEqual([150e6, 228e6, 779e6]);
    expect(scale.here).toBe(0);
  });

  it('refuses a value that no cited passage states', () => {
    const invented = withBlock(
      2,
      { ...SCALE, points: [...SCALE.points.slice(0, 2), { label: 'Sarn', value: '800', magnitude: 'million' }] },
      ['scale'],
    );
    expect(codesOf(invented)).toContain('authoring_number_not_in_evidence@items.2');
  });

  it('refuses a value the item does not cite, even when another passage states it', () => {
    expect(codesOf(withBlock(2, { ...SCALE, cites: ['e1'] }, ['scale']))).toContain(
      'authoring_number_not_in_evidence@items.2',
    );
  });

  it('refuses a value written with words, a "here" that is no point, and a log scale with a zero', () => {
    const words = withBlock(
      2,
      { ...SCALE, points: [{ label: 'Orrin', value: '150 million' }, ...SCALE.points.slice(1)] },
      ['scale'],
    );
    expect(codesOf(words)).toContain('block_value_invalid@items.2');
    expect(codesOf(withBlock(2, { ...SCALE, here: 'Moon' }, ['scale']))).toContain('scale_here_invalid@items.2');
    const zero = withBlock(
      2,
      { ...SCALE, axis: 'log', points: [{ label: 'Orrin', value: '0' }, ...SCALE.points.slice(1)] },
      ['scale'],
    );
    expect(codesOf(zero)).toContain('scale_values_invalid@items.2');
  });
});

describe('a growing chart', () => {
  it('keeps the points in the writer’s order and reads figures written as numbers or with commas', () => {
    const chart = interactiveOf(withBlock(2, CHART, ['chart']));
    if (chart.type !== 'chart') throw new Error('a chart');
    expect(chart.points.map((point) => point.value)).toEqual([100, 10000, 1000000]);
  });

  it('refuses a figure the cited passages do not state', () => {
    const invented = withBlock(
      2,
      { ...CHART, points: [...CHART.points.slice(0, 2), { label: 'A thousand crates', value: '999,999' }] },
      ['chart'],
    );
    expect(codesOf(invented)).toContain('authoring_number_not_in_evidence@items.2');
  });
});

describe('a figure with a word after it, as a passage writes it', () => {
  const POPULATION = {
    ...CHART,
    cites: ['e9'],
    unit: 'people',
    points: [
      { label: '1801', value: '8.3', magnitude: 'million' },
      { label: '1850', value: '17', magnitude: 'million' },
      { label: '1901', value: '31', magnitude: 'million' },
    ],
  };

  it('is the figure times the word, without floating-point dust', () => {
    const chart = interactiveOf(withBlock(2, POPULATION, ['chart']));
    if (chart.type !== 'chart') throw new Error('a chart');
    expect(chart.points.map((point) => point.value)).toEqual([8300000, 17000000, 31000000]);
  });

  it('refuses a word the passage does not put after that figure, and a missing word the passage always writes', () => {
    const wrongWord = {
      ...POPULATION,
      points: [{ label: '1801', value: '8.3', magnitude: 'billion' }, ...POPULATION.points.slice(1)],
    };
    expect(codesOf(withBlock(2, wrongWord, ['chart']))).toContain('block_value_invalid@items.2');
    const noWord = { ...POPULATION, points: [{ label: '1801', value: '8.3' }, ...POPULATION.points.slice(1)] };
    expect(codesOf(withBlock(2, noWord, ['chart']))).toContain('block_value_invalid@items.2');
  });

  it('allows no word where the passage writes the figure both ways, such as 17 million people and 17 sheep', () => {
    const sheep = { ...POPULATION, points: [{ label: 'Hill', value: '17' }, ...POPULATION.points.slice(1)] };
    expect(codesOf(withBlock(2, sheep, ['chart']))).not.toContain('block_value_invalid@items.2');
  });
});

describe('a fork', () => {
  it('compiles with both branches authored', () => {
    const fork = interactiveOf(withBlock(2, FORK, ['fork']));
    if (fork.type !== 'fork') throw new Error('a fork');
    expect(fork.branches.map((branch) => branch.label)).toEqual(['The north', 'The south']);
  });

  it('refuses a branch over 40 words and two paths with one label', () => {
    const long = withBlock(2, { ...FORK, branches: [{ label: 'The north', text: filler(41, 3) }, FORK.branches[1]] }, [
      'fork',
    ]);
    expect(codesOf(long)).toContain('fork_branch_too_long@items.2');
    const same = withBlock(2, { ...FORK, branches: [FORK.branches[0], { ...FORK.branches[1], label: 'The north' }] }, [
      'fork',
    ]);
    expect(codesOf(same)).toContain('fork_branches_duplicate@items.2');
  });
});

describe('which blocks a recipe allows', () => {
  it('refuses a block the recipe does not name, and a second of one it does', () => {
    expect(codesOf(withBlock(2, SORT, []))).toContain('block_unexpected@items.2');
    expect(codesOf(withBlock(2, SORT, ['fork']))).toContain('block_unexpected@items.2');
    const twice = withBlock(2, SORT, ['sort'], (draft) => (draft.items[3] = { ...draft.items[3], ...SORT }));
    expect(codesOf(twice)).toContain('block_unexpected@items.3');
  });

  it('refuses a Scroll that leaves out a block its recipe names', () => {
    expect(codesOf(withBlock(2, {}, ['sort']))).toContain('block_missing@items');
  });

  it('refuses a block as the first item and a guide on the first stop, in code and not only in the prompt', () => {
    expect(codesOf(withBlock(0, SORT, ['sort']))).toContain('block_unexpected@items.0');
    const GUIDE = { guide: { pose: 'smile', line: 'A short word from the guide.' } };
    expect(codesOf(withBlock(0, GUIDE, [], undefined, 'ray'))).toContain('guide_unexpected@items.0.guide');
  });

  it('keeps at most two play blocks in a Scroll', () => {
    const three = withBlock(2, SORT, ['sort', 'fork', 'chart'], (draft) => {
      draft.items[3] = { ...draft.items[3], ...FORK };
      draft.items[5] = { ...draft.items[5], ...CHART };
    });
    expect(codesOf(three)).toContain('interactive_budget_exceeded@items.5');
    const two = withBlock(2, SORT, ['sort', 'fork'], (draft) => (draft.items[3] = { ...draft.items[3], ...FORK }));
    expect(codesOf(two)).not.toContain('interactive_budget_exceeded@items.3');
  });

  it('adds nothing to a Scroll without blocks, so documents written before are unchanged', () => {
    const plain = compileAuthoredV2(authoredV2('plain'), compileInputV2('plain'));
    expect(plain.kind).toBe('compiled');
    expect(JSON.stringify(plain)).not.toMatch(/"interactive"|"guide"/u);
  });
});

describe('a guide', () => {
  const GUIDE = { guide: { pose: 'wonder', line: 'Doubling the work is not doubling the trips.' } };

  it('takes its character from the recipe', () => {
    const stop = documentOf(withBlock(3, GUIDE, [], undefined, 'ray')).stops[3];
    expect(stop?.kind === 'read' && stop.guide).toEqual({ character: 'ray', pose: 'wonder', line: GUIDE.guide.line });
  });

  it('is refused where the recipe has no guide, too often, too soon and too long', () => {
    expect(codesOf(withBlock(3, GUIDE, []))).toContain('guide_unexpected@items.3.guide');
    const crowded = withBlock(
      3,
      GUIDE,
      [],
      (draft) => {
        draft.items[2] = { ...draft.items[2], ...GUIDE };
        draft.items[5] = { ...draft.items[5], ...GUIDE };
        draft.items[6] = { ...draft.items[6], ...GUIDE };
      },
      'ray',
    );
    const found = codesOf(crowded);
    expect(found).toContain('guide_budget_exceeded@items.6.guide');
    expect(found).toContain('guide_too_close@items.3.guide');
    const long = withBlock(
      3,
      {
        guide: {
          pose: 'smile',
          line: 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty one two three four five six',
        },
      },
      [],
      undefined,
      'ray',
    );
    expect(codesOf(long)).toContain('guide_too_long@items.3.guide');
  });
});

describe('what the writer is told', () => {
  it('names only the blocks of the recipe, with their limits', () => {
    const none = authoringReferenceV2('plain');
    expect(none).not.toMatch(/"type":"sort"|"type":"scale"|guide:/u);
    const some = authoringReferenceV2('plain', undefined, ['sort', 'chart'], 'ray');
    expect(some).toMatch(/"type":"sort"/u);
    expect(some).toMatch(/"type":"chart"/u);
    expect(some).not.toMatch(/"type":"fork"/u);
    expect(some).toMatch(/guide:/u);
  });
});

describe('figures a passage writes in other ways (D-208)', () => {
  /** A chart of one figure three times, each with its own label, so only the figure and its word are tested. */
  const chartOf = (cites: string, unit: string, value: string | number, magnitude?: string) =>
    withBlock(
      2,
      {
        ...CHART,
        cites: [cites],
        unit,
        points: ['A', 'B', 'C'].map((label) => ({ label, value, ...(magnitude === undefined ? {} : { magnitude }) })),
      },
      ['chart'],
    );
  const refused = (outcome: Outcome) => codesOf(outcome).includes('block_value_invalid@items.2');

  it('refuses a figure with thousands commas that the passage always scales, and accepts it with its word', () => {
    expect(refused(chartOf('e10', 'people', '1,400'))).toBe(true);
    expect(refused(chartOf('e10', 'people', '1,400', 'million'))).toBe(false);
    expect(chartOf('e10', 'people', '1,400', 'million').kind).toBe('compiled');
  });

  it('refuses 8.3m, 4.1bn and 7.5 crore with no word and with a word, because a value cannot state them', () => {
    for (const figure of ['8.3', '4.1', '7.5']) {
      expect(refused(chartOf('e11', 'stones', figure)), figure).toBe(true);
      expect(refused(chartOf('e11', 'stones', figure, 'million')), figure).toBe(true);
    }
  });

  it('reads 8.3-million as 8.3 million', () => {
    expect(refused(chartOf('e12', 'crowd', '8.3'))).toBe(true);
    expect(refused(chartOf('e12', 'crowd', '8.3', 'million'))).toBe(false);
  });

  it('refuses one end of a range unless the item states the other end', () => {
    expect(refused(chartOf('e13', 'pilgrims', '8'))).toBe(true);
    expect(refused(chartOf('e13', 'pilgrims', '8', 'million'))).toBe(true);
    const states = withBlock(
      2,
      {
        ...CHART,
        cites: ['e13'],
        unit: 'pilgrims',
        points: [
          { label: 'Low end', value: '8', magnitude: 'million' },
          { label: 'High end 10', value: '10', magnitude: 'million' },
          { label: 'Again', value: '8', magnitude: 'million' },
        ],
      },
      ['chart'],
    );
    expect(refused(states)).toBe(false);
  });

  it('refuses exponent notation however the figure is written', () => {
    expect(refused(chartOf('e8', 'trips', 1.5e-7))).toBe(true);
    expect(refused(chartOf('e8', 'trips', '1.5e-7'))).toBe(true);
    expect(refused(chartOf('e8', 'trips', 1e21))).toBe(true);
  });

  it.each(POWER_FORMS)('refuses 1.5 when the passage writes it as 1.5%s', (form) => {
    const handle = `e${String(FIGURE_PASSAGES.findIndex((text) => text.endsWith(`1.5${form} grams.`)) + 1)}`;
    expect(refused(chartOf(handle, 'grams', '1.5')), form).toBe(true);
    // No magnitude word can state a power of ten, so a word does not rescue it.
    expect(refused(chartOf(handle, 'grams', '1.5', 'million')), form).toBe(true);
  });

  it('refuses the 10 and the exponent of a power of ten as figures of their own', () => {
    const handle = `e${String(FIGURE_PASSAGES.findIndex((text) => text.endsWith('1.5×10−7 grams.')) + 1)}`;
    expect(refused(chartOf(handle, 'grams', '10'))).toBe(true);
    expect(refused(chartOf(handle, 'grams', '7'))).toBe(true);
  });

  it('refuses a unit whose words no cited passage uses, and accepts one it does', () => {
    expect(refused(withBlock(2, { ...SCALE, unit: 'light years' }, ['scale']))).toBe(true);
    expect(refused(withBlock(2, { ...SCALE, unit: 'kilometres' }, ['scale']))).toBe(false);
    expect(refused(withBlock(2, { ...SCALE, unit: 'million km' }, ['scale']))).toBe(true);
  });
});
