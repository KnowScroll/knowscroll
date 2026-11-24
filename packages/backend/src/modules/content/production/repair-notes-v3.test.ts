import { describe, expect, it } from 'vitest';
import { MAX_REPAIR_NOTES_CHARS } from '../../../reasoning/public.js';
import { copyRepairNotesV3 } from './copy-notes-v3.js';
import { NOTE_PLACES_NAMED, repairNotesV3, type NoteFinding } from './repair-notes-v3.js';

const copy = (path: string, run = 'the research words here'): NoteFinding => ({
  path,
  detail: `Nine or more words in a row match the research, in the text: "${run}". Rewrite them in your own words, with a different sentence structure.`,
});
const number = (path: string, extra = ''): NoteFinding => ({
  path,
  detail: `In the text, "54" is in e11, but only as one end of a range ("… in 1801 to 54% in 1891."): a range counts only whole.${extra}`,
});

describe('repairNotesV3 (D-441, D-444)', () => {
  it('has no notes when there is nothing to say', () => {
    expect(repairNotesV3([], [])).toBeUndefined();
  });

  it('is the copy notes, unchanged, when there is no figure finding', () => {
    const findings = [copy('items.11'), copy('pictures.0')];
    expect(repairNotesV3(findings, [])).toBe(copyRepairNotesV3(findings));
  });

  it('names each place a figure is wrong at, as the model’s JSON reads it, under its own header', () => {
    const notes = repairNotesV3([], [number('items.7'), number('pictures.1.points.1.value')]) ?? '';
    const lines = notes.split('\n');
    expect(lines[0]).toContain(
      'Each line names a part of your answer, the figures in it that no passage it cites states',
    );
    expect(lines.slice(1)).toEqual([
      `items[7]: ${number('items.7').detail}`,
      `pictures[1].points[1].value: ${number('pictures.1.points.1.value').detail}`,
    ]);
  });

  it('writes the copies and then the figures, each block under its own header', () => {
    const notes = repairNotesV3([copy('items.11')], [number('items.7')]) ?? '';
    const blocks = notes.split('\n\n');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain('items[11]: Nine or more words');
    expect(blocks[1]).toContain('items[7]: In the text, "54"');
  });

  it('fits the harness limit, dropping whole lines from the block that shows more and naming the places it has no room for', () => {
    const copies = Array.from({ length: 30 }, (_unused, index) =>
      copy(`items.${String(index)}`, 'word '.repeat(14).trim()),
    );
    const numbers = Array.from({ length: 30 }, (_unused, index) =>
      number(`items.${String(index + 40)}`, ' x'.repeat(40)),
    );
    const notes = repairNotesV3(copies, numbers) ?? '';
    expect(notes.length).toBeLessThanOrEqual(MAX_REPAIR_NOTES_CHARS);
    const [copyBlock = '', numberBlock = ''] = notes.split('\n\n');
    const shownCopies = copyBlock.split('\n').filter((line) => /^items\[\d+\]: /u.test(line));
    const shownNumbers = numberBlock.split('\n').filter((line) => /^items\[\d+\]: /u.test(line));
    // Both kinds keep lines, in order from the first, and neither crowds the other out.
    expect(shownCopies.length).toBeGreaterThan(1);
    expect(shownNumbers.length).toBeGreaterThan(1);
    expect(shownCopies[0]).toContain('items[0]:');
    expect(shownNumbers[0]).toContain('items[40]:');
    expect(copyBlock.split('\n').at(-1)?.startsWith('Also copying: items[')).toBe(true);
    expect(numberBlock.split('\n').at(-1)?.startsWith('Also with figures to check: items[4')).toBe(true);
    expect(numberBlock.split('\n').at(-1)?.split(', ')).toHaveLength(NOTE_PLACES_NAMED);
  });

  it('keeps the first line of a block that is alone however long it is, cut to the limit', () => {
    const notes = repairNotesV3([], [number('items.3', ` ${'x'.repeat(5000)}`)]) ?? '';
    expect(notes.length).toBeLessThanOrEqual(MAX_REPAIR_NOTES_CHARS);
    expect(notes).toContain('items[3]: In the text, "54"');
    expect(notes.endsWith('…')).toBe(true);
  });

  it('cuts the whole text, never past the limit, when even one line of each kind is too long', () => {
    const notes = repairNotesV3([copy('items.1', 'x'.repeat(3000))], [number('items.2', ` ${'y'.repeat(3000)}`)]) ?? '';
    expect(notes.length).toBeLessThanOrEqual(MAX_REPAIR_NOTES_CHARS);
    expect(notes).toContain('items[1]: Nine or more words');
  });
});
