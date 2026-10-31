import { describe, expect, it } from 'vitest';
import { authoredV2, compileInputV2 } from '../test-support/v2-fixtures.js';
import { compileAuthoredV2 } from '../producer/v2/compile.js';
import {
  describeChart,
  describeFork,
  describeScale,
  formatFigure,
  interactiveWords,
  INTERACTIVE_KINDS,
  isSortRight,
  sortedItems,
  sortPlacedRight,
  type Interactive,
} from './blocks.js';
import type { ScrollDocumentV2 } from './document.js';
import { INTERACTION_KINDS_V2 } from './interactions.js';
import { computeMeasuresV2, SECONDS_PER_INTERACTIVE } from './measures.js';
import { computeIntegrityV2, validateDocumentV2 } from './validate.js';

/** CI fixtures: blocks written straight into the document, then measured and signed the way code does. */
const SORT: Interactive = {
  type: 'sort',
  items: ['Gamma step', 'Alpha step', 'Beta step'],
  order: [1, 2, 0],
  explain: 'Alpha leads to beta, which leads to gamma.',
};
const SCALE: Interactive = {
  type: 'scale',
  axis: 'linear',
  unit: 'units',
  points: [
    { label: 'Near', value: 1 },
    { label: 'Middle', value: 4 },
    { label: 'Far', value: 9 },
  ],
  here: 1,
};
const CHART: Interactive = {
  type: 'chart',
  shape: 'line',
  unit: 'units',
  points: [
    { label: 'One', value: 1 },
    { label: 'Two', value: 2 },
    { label: 'Three', value: 3 },
  ],
};
const FORK: Interactive = {
  type: 'fork',
  prompt: 'Which way?',
  branches: [
    { label: 'Left', text: 'The left path says a thing.' },
    { label: 'Right', text: 'The right path says another thing.' },
  ],
};

function baseDocument(): ScrollDocumentV2 {
  const outcome = compileAuthoredV2(authoredV2('plain'), compileInputV2('plain'));
  if (outcome.kind !== 'compiled') throw new Error('the plain fixture compiles');
  return JSON.parse(JSON.stringify(outcome.document)) as ScrollDocumentV2;
}

/** The fixture with `edit` applied to its stops, re-measured and re-signed so only the edit can be refused. */
function edited(edit: (stops: ScrollDocumentV2['stops']) => void): ReturnType<typeof validateDocumentV2> {
  const document = baseDocument();
  edit(document.stops);
  const measured = { ...document, measures: computeMeasuresV2(document) };
  const { integrity: _integrity, ...unsigned } = measured;
  return validateDocumentV2({
    ...measured,
    integrity: { ...document.integrity, sha256: computeIntegrityV2(unsigned) },
  });
}

const give = (stops: ScrollDocumentV2['stops'], at: number, extra: object): void => {
  const stop = stops[at];
  if (stop?.kind !== 'read') throw new Error('a read stop');
  Object.assign(stop, extra);
};
const issuesOf = (outcome: ReturnType<typeof validateDocumentV2>) =>
  outcome.kind === 'invalid' ? outcome.issues.map((issue) => `${issue.code}@${issue.path}`) : [];

describe('the play blocks of a document', () => {
  it('admit each of the four kinds once the document is measured and signed', () => {
    for (const block of [SORT, SCALE, CHART, FORK])
      expect(issuesOf(edited((stops) => give(stops, 2, { interactive: block })))).toEqual([]);
  });

  it('refuse a sort that has no order to find, or whose order is not a permutation of its items', () => {
    expect(issuesOf(edited((stops) => give(stops, 2, { interactive: { ...SORT, order: [0, 1, 2] } })))).toContain(
      'sort_already_ordered@stops.2.interactive.items',
    );
    expect(issuesOf(edited((stops) => give(stops, 2, { interactive: { ...SORT, order: [1, 1, 0] } })))).toContain(
      'sort_order_invalid@stops.2.interactive.order',
    );
    expect(issuesOf(edited((stops) => give(stops, 2, { interactive: { ...SORT, order: [1, 2, 3] } })))).toContain(
      'sort_order_invalid@stops.2.interactive.order',
    );
  });

  it('refuse a scale whose values do not rise, a log scale that has a zero, and a "you are here" that is no point', () => {
    const points = [
      SCALE.type === 'scale' ? SCALE.points[1] : undefined,
      SCALE.type === 'scale' ? SCALE.points[0] : undefined,
    ];
    expect(
      issuesOf(
        edited((stops) =>
          give(stops, 2, { interactive: { ...SCALE, points: [...points, ...[{ label: 'Far', value: 9 }]] } }),
        ),
      ),
    ).toContain('scale_values_invalid@stops.2.interactive.points');
    expect(
      issuesOf(
        edited((stops) =>
          give(stops, 2, {
            interactive: {
              ...SCALE,
              axis: 'log',
              points: [
                { label: 'Zero', value: 0 },
                { label: 'One', value: 1 },
                { label: 'Two', value: 2 },
              ],
            },
          }),
        ),
      ),
    ).toContain('scale_values_invalid@stops.2.interactive.points');
    expect(issuesOf(edited((stops) => give(stops, 2, { interactive: { ...SCALE, here: 5 } })))).toContain(
      'scale_here_invalid@stops.2.interactive.here',
    );
  });

  it('keep at most two interactives, and a guide that speaks rarely', () => {
    expect(
      issuesOf(
        edited((stops) => {
          give(stops, 0, { interactive: SORT });
          give(stops, 2, { interactive: CHART });
          give(stops, 3, { interactive: FORK });
        }),
      ),
    ).toContain('interactive_budget_exceeded@stops.3.interactive');
    const guide = { character: 'ray', pose: 'smile', line: 'A short word from the guide.' };
    expect(
      issuesOf(
        edited((stops) => {
          give(stops, 2, { guide });
          give(stops, 3, { guide });
        }),
      ),
    ).toContain('guide_too_close@stops.3.guide');
    expect(
      issuesOf(
        edited((stops) => {
          give(stops, 2, { guide });
          give(stops, 5, { guide });
        }),
      ),
    ).toEqual([]);
  });

  it('count the words of the block and ten seconds of play in the reading time, and nothing else changes', () => {
    const document = baseDocument();
    const before = computeMeasuresV2(document);
    const stops = document.stops.map((stop, index) =>
      index === 2 && stop.kind === 'read' ? { ...stop, interactive: SORT } : stop,
    );
    const after = computeMeasuresV2({ ...document, stops });
    const added = interactiveWords(SORT);
    expect(after.stops[2]?.weight).toBe((before.stops[2]?.weight ?? 0) + added);
    expect(after.readingSeconds - before.readingSeconds).toBe(Math.round((added * 60) / 230) + SECONDS_PER_INTERACTIVE);
    expect(after.stops.filter((_, index) => index !== 2)).toEqual(before.stops.filter((_, index) => index !== 2));
  });

  it('count the longer fork branch, as a call counts the longer path', () => {
    expect(interactiveWords(FORK)).toBe(2 + 1 + 1 + 5);
  });
});

describe('a sort is checked from the document', () => {
  it('right only when every item stands where the document puts it, and says how many do', () => {
    if (SORT.type !== 'sort') throw new Error('a sort');
    expect(sortedItems(SORT)).toEqual(['Alpha step', 'Beta step', 'Gamma step']);
    expect(isSortRight(SORT, [1, 2, 0])).toBe(true);
    expect(isSortRight(SORT, [1, 0, 2])).toBe(false);
    expect(isSortRight(SORT, [1, 2])).toBe(false);
    expect(sortPlacedRight(SORT, [1, 0, 2])).toBe(1);
    expect(sortPlacedRight(SORT, [0, 1, 2])).toBe(0);
  });
});

describe('the text version of a block is derived from its data', () => {
  it('lists a scale from the smallest to the largest and says where "you are here" is', () => {
    if (SCALE.type !== 'scale') throw new Error('a scale');
    expect(describeScale(SCALE)).toBe(
      'A linear scale in units, from smallest to largest. Near: 1 units; Middle: 4 units; Far: 9 units. You are here: Middle.',
    );
  });

  it('lists a chart in order and both paths of a fork', () => {
    if (CHART.type !== 'chart' || FORK.type !== 'fork') throw new Error('a chart and a fork');
    expect(describeChart(CHART)).toBe('A line chart in units, in order. One: 1 units; Two: 2 units; Three: 3 units.');
    expect(describeFork(FORK)).toBe(
      'Which way? Left: The left path says a thing. Right: The right path says another thing.',
    );
  });

  it('writes a figure the way a reader expects', () => {
    expect(formatFigure(1000000)).toBe('1,000,000');
    expect(formatFigure(1.52)).toBe('1.52');
    expect(formatFigure(150)).toBe('150');
    expect(formatFigure(0.5)).toBe('0.5');
  });
});

describe('the play wall: a block reports nothing (D-063, D-209)', () => {
  it('has no interaction kind for any block, so nothing a reader does with one can be sent', () => {
    expect(Object.keys(INTERACTION_KINDS_V2).sort()).toEqual(['call_it', 'final_call']);
    for (const kinds of Object.values(INTERACTION_KINDS_V2)) expect([...kinds].sort()).toEqual(['locked', 'revealed']);
    for (const block of INTERACTIVE_KINDS) expect(Object.keys(INTERACTION_KINDS_V2)).not.toContain(block);
    expect(Object.keys(INTERACTION_KINDS_V2)).not.toContain('guide');
  });
});
