import { COPY_RUN_WORDS, copiedRuns } from '@knowscroll/scroll-model/producer';
import { MAX_REPAIR_NOTES_CHARS } from '../../../reasoning/public.js';

/** The most copied runs a repair names in all. */
export const REPAIR_NOTE_RUNS = 6;
/** The most words of one copied run a repair shows; a longer run ends in an ellipsis. */
export const REPAIR_NOTE_RUN_WORDS = 20;
/** The most places with no room for a run that are named by their reference; the others are counted. */
export const REPAIR_NOTE_PLACES = 12;

/** A place in a refused answer where the copy check found a copied run. */
export interface CopiedPlace {
  /** How the repair refers to the place (`blocks[3]`, `title`): a position in the draft, never its words. */
  readonly where: string;
  /** The reader strings at that place. */
  readonly texts: readonly string[];
}

interface Found {
  readonly where: string;
  readonly runs: readonly string[];
}

/** How a run is written into a line. */
type ShowRun = (run: string) => string;

const firstWords: ShowRun = (run) => {
  const words = run.split(' ');
  return words.length > REPAIR_NOTE_RUN_WORDS ? `${words.slice(0, REPAIR_NOTE_RUN_WORDS).join(' ')} …` : run;
};

/** `text` cut to at most `max` characters, ending in an ellipsis, never between the halves of a surrogate pair. */
function cutToChars(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = Math.max(0, max - 1);
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end).trimEnd()}…`;
}

/**
 * The runs to show, `limit` at most: each place with a copy is named by its first run before any place gets a second, so
 * that a long copy in one block never hides another block's.
 */
function pickRuns(found: readonly Found[], limit: number) {
  return found
    .flatMap((place, placeIndex) => place.runs.map((run, runIndex) => ({ placeIndex, runIndex, run })))
    .sort((first, second) => first.runIndex - second.runIndex || first.placeIndex - second.placeIndex)
    .slice(0, limit);
}

const HEADER =
  'Each line names a place in your text and the words there that also appear, in a row, in the source passages (lower case, no punctuation). Rebuild each sentence that holds them in your own words: keep its key terms, but change the order of the ideas and the shape of the sentence, not only a word or two. Keep every other sentence as it is.';

/** The places that have no run among the shown ones: named by reference up to {@link REPAIR_NOTE_PLACES}, then counted. */
function unnamedLine(unnamed: readonly Found[]): readonly string[] {
  if (unnamed.length === 0) return [];
  const names = unnamed.slice(0, REPAIR_NOTE_PLACES).map((place) => place.where);
  const rest = unnamed.length - names.length;
  return [`Also copying: ${names.join(', ')}${rest > 0 ? ` and ${String(rest)} more` : ''}.`];
}

function render(found: readonly Found[], limit: number, showRun: ShowRun): string {
  const picks = pickRuns(found, limit);
  const lines = found.flatMap((place, placeIndex) => {
    const shown = picks.filter((pick) => pick.placeIndex === placeIndex).map((pick) => `"${showRun(pick.run)}"`);
    return shown.length === 0 ? [] : [`${place.where} copies: ${shown.join(' | ')}`];
  });
  const unnamed = found.filter((_place, placeIndex) => !picks.some((pick) => pick.placeIndex === placeIndex));
  const total = found.reduce((sum, place) => sum + place.runs.length, 0);
  return [
    HEADER,
    ...lines,
    ...unnamedLine(unnamed),
    ...(total > picks.length
      ? [
          `More runs of ${String(COPY_RUN_WORDS)} or more words are copied than are shown: rebuild every sentence there that repeats a passage.`,
        ]
      : []),
  ].join('\n');
}

/**
 * What a writer's one repair is told about a draft refused for `copied_passage`: for each place, the words of the
 * passages that its text repeats, and an ask to rebuild those sentences in the writer's own words, keeping the key terms.
 * At most {@link REPAIR_NOTE_RUNS} runs of {@link REPAIR_NOTE_RUN_WORDS} words are shown, and the places with no room for a
 * run are named up to {@link REPAIR_NOTE_PLACES} and counted after that. The notes always fit {@link MAX_REPAIR_NOTES_CHARS},
 * so the harness never cuts them: runs are dropped whole, last to first, until they fit; and if even one run of twenty words
 * is too long (very long words), that single run is cut to the room the rest of the notes leave. Every run is cut by the copy
 * check from words the sources hold (public text, the same the draft was compared with); of the draft only the position of a
 * place is named, never anything the model wrote. `undefined` when no place holds a run.
 */
export function copyRepairNotes(places: readonly CopiedPlace[], sources: readonly string[]): string | undefined {
  const found = places
    .map((place): Found => ({
      where: place.where,
      runs: [...new Set(place.texts.flatMap((text) => copiedRuns(text, sources, COPY_RUN_WORDS)))],
    }))
    .filter((place) => place.runs.length > 0);
  if (found.length === 0) return undefined;
  for (let limit = REPAIR_NOTE_RUNS; limit >= 1; limit -= 1) {
    const notes = render(found, limit, firstWords);
    if (notes.length <= MAX_REPAIR_NOTES_CHARS) return notes;
  }
  const room = Math.max(0, MAX_REPAIR_NOTES_CHARS - render(found, 1, () => '').length);
  return render(found, 1, (run) => cutToChars(firstWords(run), room));
}
