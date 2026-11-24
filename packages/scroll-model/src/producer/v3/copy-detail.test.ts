import { describe, expect, it } from 'vitest';
import { COPY_DETAIL_RUNS, copyDetailV3, type CopiedRun } from './copy-detail.js';

const run = (index: number, field = 'text'): CopiedRun => ({
  field,
  run: `run number ${String(index)} of the words that the research writes`,
});

describe('copyDetailV3: every run of a place, within a bound (D-444)', () => {
  it('quotes up to four runs, each with the part it stands in', () => {
    expect(COPY_DETAIL_RUNS).toBe(4);
    const detail = copyDetailV3([run(1), run(2, 'simpler text'), run(3), run(4, 'caption')]);
    expect(detail).toBe(
      'Nine or more words in a row match the research, in the text: "run number 1 of the words that the research writes"; in the simpler text: "run number 2 of the words that the research writes"; in the text: "run number 3 of the words that the research writes"; in the caption: "run number 4 of the words that the research writes". Rewrite them in your own words, with a different sentence structure.',
    );
  });

  it('counts the runs beyond the fourth', () => {
    const six = [1, 2, 3, 4, 5, 6].map((index) => run(index));
    const detail = copyDetailV3(six);
    expect(detail).toContain('(2 more runs not shown)');
    expect(detail).not.toContain('run number 5');
    expect(copyDetailV3([1, 2, 3, 4, 5].map((index) => run(index)))).toContain('(1 more run not shown)');
  });
});
