import { describe, expect, it } from 'vitest';
import { MAX_REPAIR_NOTES_CHARS } from '../../../reasoning/public.js';
import { COPY_NOTE_PLACES, copyRepairNotesV3, type CopyFinding } from './copy-notes-v3.js';

const finding = (path: string, run = 'the research words here'): CopyFinding => ({
  path,
  detail: `Nine or more words in a row match the research, in the text: "${run}". Rewrite them in your own words, with a different sentence structure.`,
});

describe('copyRepairNotesV3', () => {
  it('has no notes when nothing copies', () => {
    expect(copyRepairNotesV3([])).toBeUndefined();
  });

  it('names each place as the model’s JSON reads it, with the compile’s own sentence', () => {
    const notes = copyRepairNotesV3([finding('items.11'), finding('pictures.0'), finding('items.8.title')]) ?? '';
    const lines = notes.split('\n');
    expect(lines[0]).toContain('Each line names an item of your answer');
    expect(lines.slice(1)).toEqual([
      `items[11]: ${finding('items.11').detail}`,
      `pictures[0]: ${finding('pictures.0').detail}`,
      `items[8].title: ${finding('items.8.title').detail}`,
    ]);
  });

  it('fits the harness limit, dropping whole lines from the end and naming the places it has no room for', () => {
    const many = Array.from({ length: 40 }, (_unused, index) =>
      finding(`items.${String(index)}`, 'word '.repeat(14).trim()),
    );
    const notes = copyRepairNotesV3(many) ?? '';
    expect(notes.length).toBeLessThanOrEqual(MAX_REPAIR_NOTES_CHARS);
    const lines = notes.split('\n');
    const shown = lines.filter((line) => /^items\[\d+\]: /u.test(line));
    expect(shown.length).toBeGreaterThan(2);
    expect(shown.length).toBeLessThan(40);
    expect(shown[0]).toContain('items[0]:');
    const tail = lines.at(-1) ?? '';
    expect(tail.startsWith(`Also copying: items[${String(shown.length)}], `)).toBe(true);
    expect(tail).toContain(`and ${String(40 - shown.length - COPY_NOTE_PLACES)} more.`);
    expect(tail.split(', ')).toHaveLength(COPY_NOTE_PLACES);
  });

  it('cuts the one line that is longer than the room, never past the limit', () => {
    const huge = copyRepairNotesV3([finding('items.1', 'x'.repeat(5000))]) ?? '';
    expect(huge.length).toBeLessThanOrEqual(MAX_REPAIR_NOTES_CHARS);
    expect(huge).toContain('items[1]: Nine or more words');
    expect(huge.endsWith('…')).toBe(true);
  });
});
