import { copiedRunsIn, copyMaterial } from '../../text.js';
import { COPY_RUN_WORDS } from '../compile.js';

/** The most words of one copied run a finding quotes; a longer run ends in an ellipsis. */
export const COPY_DETAIL_RUN_WORDS = 15;
/** The most runs of one item a finding quotes; the others are counted. */
export const COPY_DETAIL_RUNS = 2;

/** One run of words that an item copies from the research, and the part of the item it stands in ("text", "caption"). */
export interface CopiedRun {
  readonly field: string;
  /** The run as the copy check compares it: lower case, no punctuation. */
  readonly run: string;
}

/** A string of an item and what a finding calls it. */
export interface NamedText {
  readonly field: string;
  readonly text: string;
}

/** The research material the copy check compares texts with, built once for many texts. */
export const copyMaterialOf = (sources: readonly string[]): ReadonlySet<string> =>
  copyMaterial(sources, COPY_RUN_WORDS);

/** Every copied run of the strings of one item, each with the part it stands in, in the order of the strings. */
export function copiedRunsOfFields(fields: readonly NamedText[], material: ReadonlySet<string>): CopiedRun[] {
  return fields.flatMap(({ field, text }) =>
    copiedRunsIn(text, material, COPY_RUN_WORDS).map((run): CopiedRun => ({ field, run })),
  );
}

function shown(run: string): string {
  const words = run.split(' ');
  return words.length > COPY_DETAIL_RUN_WORDS ? `${words.slice(0, COPY_DETAIL_RUN_WORDS).join(' ')} …` : run;
}

/**
 * What the repair is told about an item that copies: the part of the item and the words, as the research writes them
 * (first {@link COPY_DETAIL_RUNS} runs, each cut to {@link COPY_DETAIL_RUN_WORDS} words), and the ask to say them in the
 * writer's own words. Built from the research's words only, never from words the model wrote. The words of a run are
 * the research's, a public page the writer was given. `runs` must not be empty.
 *
 * The harness's own repair catalogue is static (a hint of at most 256 characters per code), so this sentence cannot
 * ride on the finding there: the writer sends it in the repair notes.
 */
export function copyDetailV3(runs: readonly CopiedRun[]): string {
  const named = runs.slice(0, COPY_DETAIL_RUNS).map(({ field, run }) => `in the ${field}: "${shown(run)}"`);
  const rest = runs.length - COPY_DETAIL_RUNS;
  const more = rest > 0 ? ` (${String(rest)} more ${rest === 1 ? 'run' : 'runs'} not shown)` : '';
  return `Nine or more words in a row match the research, ${named.join('; ')}${more}. Rewrite them in your own words, with a different sentence structure.`;
}
