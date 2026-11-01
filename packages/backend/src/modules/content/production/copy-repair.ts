import { COPY_RUN_WORDS, copiedRuns } from '@knowscroll/scroll-model/producer';
import { MAX_REPAIR_NOTES_CHARS } from '../../../reasoning/public.js';

/** The most copied runs a repair names in all. */
export const REPAIR_NOTE_RUNS = 6;
/** The most words of one copied run a repair shows; a longer run ends in an ellipsis. */
export const REPAIR_NOTE_RUN_WORDS = 20;

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

const shortened = (run: string): string => {
  const words = run.split(' ');
  return words.length > REPAIR_NOTE_RUN_WORDS ? `${words.slice(0, REPAIR_NOTE_RUN_WORDS).join(' ')} …` : run;
};

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

function render(found: readonly Found[], limit: number): string {
  const picks = pickRuns(found, limit);
  const lines = found.flatMap((place, placeIndex) => {
    const shown = picks.filter((pick) => pick.placeIndex === placeIndex).map((pick) => `"${shortened(pick.run)}"`);
    return shown.length === 0 ? [] : [`${place.where} copies: ${shown.join(' | ')}`];
  });
  const unnamed = found.filter((_place, placeIndex) => !picks.some((pick) => pick.placeIndex === placeIndex));
  const total = found.reduce((sum, place) => sum + place.runs.length, 0);
  return [
    HEADER,
    ...lines,
    ...(unnamed.length === 0 ? [] : [`Also copying: ${unnamed.map((place) => place.where).join(', ')}.`]),
    ...(total > picks.length
      ? [`More runs of ${String(COPY_RUN_WORDS)} or more words are copied than are shown: rebuild every sentence there that repeats a passage.`]
      : []),
  ].join('\n');
}

/**
 * What a writer's one repair is told about a draft refused for `copied_passage`: for each place, the words of the
 * passages that its text repeats, and an ask to rebuild those sentences in the writer's own words, keeping the key terms.
 * At most {@link REPAIR_NOTE_RUNS} runs of {@link REPAIR_NOTE_RUN_WORDS} words are shown, and the notes fit
 * {@link MAX_REPAIR_NOTES_CHARS}, so the harness never cuts them. Every run is cut by the copy check from words the sources
 * hold (public text, the same the draft was compared with); of the draft only the position of a place is named, never
 * anything the model wrote. `undefined` when no place holds a run.
 */
export function copyRepairNotes(places: readonly CopiedPlace[], sources: readonly string[]): string | undefined {
  const found = places
    .map((place): Found => ({
      where: place.where,
      runs: [...new Set(place.texts.flatMap((text) => copiedRuns(text, sources, COPY_RUN_WORDS)))],
    }))
    .filter((place) => place.runs.length > 0);
  if (found.length === 0) return undefined;
  for (let limit = REPAIR_NOTE_RUNS; limit > 1; limit -= 1) {
    const notes = render(found, limit);
    if (notes.length <= MAX_REPAIR_NOTES_CHARS) return notes;
  }
  return render(found, 1);
}
