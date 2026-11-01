import { describe, expect, it } from 'vitest';
import { COPY_RUN_WORDS } from '@knowscroll/scroll-model/producer';
import { MAX_REPAIR_NOTES_CHARS } from '../../../reasoning/public.js';
import { copyRepairNotes, REPAIR_NOTE_RUN_WORDS, REPAIR_NOTE_RUNS, type CopiedPlace } from './copy-repair.js';

/**
 * Labelled CI fixtures: invented passage sentences, and drafts that repeat some of their words. Nothing here is provider
 * output or product content.
 */
const CANAL = 'A canal lock raises a boat by letting water into a closed chamber until the level matches.';
const KETTLE = 'The kettle thermostat switches the heater off once the water reaches a rolling boil.';
const BRIDGE = 'The old bridge is closed in heavy snow because the ice makes the ramp unsafe.';
const SOURCES = [CANAL, KETTLE, BRIDGE];

/** `count` words that no passage holds, tagged so two runs of them never match. */
const ownWords = (tag: string, count = 12): string =>
  Array.from({ length: count }, (_unused, index) => `${tag}${String(index)}`).join(' ');

const place = (where: string, ...texts: string[]): CopiedPlace => ({ where, texts });

/** The words of a sentence as the copy check compares them: lower case, no punctuation. */
const plain = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '');

describe('the notes that go with a repair after a copy finding (D-294)', () => {
  it('name each place and the passage’s own words that its text repeats, and ask for a rebuild that keeps the key terms', () => {
    const notes = copyRepairNotes(
      [
        place('blocks[1]', `${ownWords('first')} ${CANAL} ${ownWords('second')}`),
        place('blocks[4]', KETTLE),
        place('title', `${ownWords('third')} and some more`),
      ],
      SOURCES,
    );
    expect(notes).toContain(`blocks[1] copies: "${plain(CANAL)}"`);
    expect(notes).toContain(`blocks[4] copies: "${plain(KETTLE)}"`);
    expect(notes).not.toContain('title copies');
    expect(notes).toContain('Rebuild each sentence that holds them in your own words: keep its key terms');
    expect(notes).toContain('Keep every other sentence as it is.');
  });

  it('shows two separate runs of one place, and a run once however many strings repeat it', () => {
    const notes = copyRepairNotes(
      [place('blocks[2]', `${CANAL} ${ownWords('mid')} ${BRIDGE}`, CANAL)],
      SOURCES,
    );
    expect(notes).toContain(`blocks[2] copies: "${plain(CANAL)}" | "${plain(BRIDGE)}"`);
    expect(notes?.split(plain(CANAL))).toHaveLength(2);
  });

  it('echoes nothing the model wrote: of its draft only the block reference, and runs cut from the passages', () => {
    const draft = `${ownWords('canary')} ${CANAL} ${ownWords('marmalade')}`;
    const notes = copyRepairNotes([place('blocks[3]', draft)], SOURCES) ?? '';
    expect(notes).not.toMatch(/canary|marmalade/u);
    // The only words in quotation marks are the passage's.
    const quoted = [...notes.matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
    expect(quoted).toEqual([plain(CANAL)]);
  });

  it('shows no more than 20 words of a longer run, and ends it with an ellipsis', () => {
    const long = `${CANAL} ${KETTLE}`;
    const longSources = [long];
    const notes = copyRepairNotes([place('blocks[0]', long)], longSources) ?? '';
    const shown = /blocks\[0\] copies: "([^"]+)"/u.exec(notes)?.[1] ?? '';
    expect(REPAIR_NOTE_RUN_WORDS).toBe(20);
    expect(shown.endsWith(' …')).toBe(true);
    expect(shown.replace(/ …$/u, '').split(' ')).toEqual(plain(long).split(/\s+/u).slice(0, REPAIR_NOTE_RUN_WORDS));
  });

  it('names no more than six runs in all, but a first run of every place before a second of any', () => {
    const threeRuns = (tag: string) => `${CANAL} ${ownWords(tag)} ${BRIDGE} ${ownWords(`${tag}end`)} ${KETTLE}`;
    const places = [0, 1, 2, 3].map((index) => place(`blocks[${String(index)}]`, threeRuns(`p${String(index)}`)));
    const notes = copyRepairNotes(places, SOURCES) ?? '';
    expect(REPAIR_NOTE_RUNS).toBe(6);
    const shownRuns = [...notes.matchAll(/ copies: (.+)$/gmu)].flatMap((line) => line[1]!.split(' | '));
    expect(shownRuns).toHaveLength(REPAIR_NOTE_RUNS);
    // Each of the four places is named by its first run; the two runs left go to the first two places.
    const linesOf = (block: string) => new RegExp(`${block.replace(/[[\]]/gu, '\\$&')} copies: (.+)$`, 'mu').exec(notes)?.[1];
    expect(linesOf('blocks[0]')?.split(' | ')).toHaveLength(2);
    expect(linesOf('blocks[1]')?.split(' | ')).toHaveLength(2);
    expect(linesOf('blocks[2]')?.split(' | ')).toHaveLength(1);
    expect(linesOf('blocks[3]')?.split(' | ')).toHaveLength(1);
    expect(notes).toContain(`More runs of ${String(COPY_RUN_WORDS)} or more words are copied than are shown`);
  });

  it('names a place it has no room to quote, by its reference alone', () => {
    const places = Array.from({ length: 8 }, (_unused, index) => place(`blocks[${String(index)}]`, CANAL));
    const notes = copyRepairNotes(places, SOURCES) ?? '';
    expect([...notes.matchAll(/^blocks\[\d+\] copies:/gmu)]).toHaveLength(REPAIR_NOTE_RUNS);
    expect(notes).toContain('Also copying: blocks[6], blocks[7].');
  });

  it('says nothing of more runs when every run is shown', () => {
    const notes = copyRepairNotes([place('blocks[0]', CANAL), place('blocks[1]', KETTLE)], SOURCES) ?? '';
    expect(notes).not.toContain('More runs');
    expect(notes).not.toContain('Also copying');
  });

  it('fits the limit the harness cuts at, even for the longest words, without cutting a line', () => {
    const longWord = 'x'.repeat(40);
    const words = (tag: string) => Array.from({ length: 30 }, (_unused, index) => `${tag}${longWord}${String(index)}`).join(' ');
    const sources = [0, 1, 2, 3, 4, 5].map((index) => words(`s${String(index)}`));
    const places = sources.map((text, index) => place(`blocks[${String(index)}]`, text));
    const notes = copyRepairNotes(places, sources) ?? '';
    expect(notes.length).toBeLessThanOrEqual(MAX_REPAIR_NOTES_CHARS);
    for (const line of notes.split('\n').filter((one) => one.includes(' copies: '))) expect(line.endsWith('"')).toBe(true);
    // Fewer runs than the cap are shown here, because six would not fit, and the notes say that more remain.
    expect([...notes.matchAll(/ copies: (.+)$/gmu)].flatMap((line) => line[1]!.split(' | ')).length).toBeLessThan(
      REPAIR_NOTE_RUNS,
    );
    expect(notes).toContain('More runs');
  });

  it.each([
    ['no place', []],
    ['a place whose text copies nothing', [place('blocks[0]', ownWords('plain'))]],
    ['a run one word short of the rule', [place('blocks[0]', CANAL.split(' ').slice(0, COPY_RUN_WORDS - 1).join(' '))]],
  ])('has no notes for %s', (_label, places) => {
    expect(copyRepairNotes(places, SOURCES)).toBeUndefined();
  });

  it('names a run of exactly the rule’s number of words', () => {
    const exactly = CANAL.split(' ').slice(0, COPY_RUN_WORDS).join(' ');
    expect(copyRepairNotes([place('blocks[0]', exactly)], SOURCES)).toContain(`blocks[0] copies: "${plain(exactly)}"`);
  });
});
