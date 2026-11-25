import { MAX_REPAIR_NOTES_CHARS } from '../../../reasoning/public.js';

/** The most places with no room for their line that are named in a closing line; the others are counted. */
export const NOTE_PLACES_NAMED = 12;

/** A finding of the document v3 compile that carries a detail for the repair notes: where it is in the model's reply, and what to tell the model about it. */
export interface NoteFinding {
  /** The model's own path (`items.11`, `pictures.0`, `pictures.1.points.1.value`). */
  readonly path: string;
  /** From the compile: the research's words and the figure or run as the model wrote it (`copyDetailV3`, `numberDetailOfTexts`). */
  readonly detail: string;
}

/** What one kind of finding is called in the notes, and the paragraph that opens its block. */
interface Kind {
  readonly header: string;
  /** The closing line's lead for the places that have no room for their line. */
  readonly also: string;
}

/**
 * What both headers end on, for the first repair and the second (D-445): a repair rewrites only the places its notes name, because a
 * part it rewrites that nobody named can copy the research anew. Short on purpose: both blocks share `MAX_REPAIR_NOTES_CHARS`.
 */
const CHANGE_ONLY_NAMED = 'Change only these parts; return all else exactly as it was.';

const COPY: Kind = {
  header: `Each line names an item of your answer, the part of it that repeats the research, and the words that match (lower case, no punctuation). Rebuild each sentence that holds them in your own words: keep its key terms, but change the order of the ideas and the shape of the sentence, not only a word or two. Keep a figure, but put it in a sentence of your own: a figure with the research’s phrase around it is still a copy. ${CHANGE_ONLY_NAMED}`,
  also: 'Also copying',
};

const NUMBER: Kind = {
  header: `Each line names a part of your answer, the figures in it that no passage it cites states the way you wrote them, and where the research has them. Fix each as its line says: cite the passage it names, write the figure as that passage does, or say it in words. ${CHANGE_ONLY_NAMED}`,
  also: 'Also with figures to check',
};

/** The path as the model's JSON reads it: `items.11` is `items[11]`. */
export const placeOf = (path: string): string => path.replace(/\.(\d+)/gu, '[$1]');

/** `text` cut to at most `max` characters, ending in an ellipsis, never between the halves of a surrogate pair. */
export function cutToChars(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = Math.max(0, max - 1);
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end).trimEnd()}…`;
}

/** The places that have no line among the shown ones: named by reference up to {@link NOTE_PLACES_NAMED}, then counted. */
function unnamedLine(kind: Kind, unnamed: readonly NoteFinding[]): readonly string[] {
  if (unnamed.length === 0) return [];
  const names = unnamed.slice(0, NOTE_PLACES_NAMED).map((finding) => placeOf(finding.path));
  const rest = unnamed.length - names.length;
  return [`${kind.also}: ${names.join(', ')}${rest > 0 ? ` and ${String(rest)} more` : ''}.`];
}

/** One block of notes: the header, a line for each of the first `shown` findings and the closing line for the rest. */
function block(kind: Kind, findings: readonly NoteFinding[], shown: number, cutLine?: number): string {
  if (findings.length === 0) return '';
  const lines = findings
    .slice(0, shown)
    .map((finding) => `${placeOf(finding.path)}: ${finding.detail}`)
    .map((line, index) => (index === 0 && cutLine !== undefined ? cutToChars(line, cutLine) : line));
  return [kind.header, ...lines, ...unnamedLine(kind, findings.slice(shown))].join('\n');
}

const joined = (copies: string, numbers: string): string =>
  [copies, numbers].filter((text) => text !== '').join('\n\n');

/**
 * What the writer's repairs are told about a draft refused for `copied_passage` or `authoring_number_not_in_evidence` (the
 * harness's catalogue is static and holds one fixed hint per code, so the part, the words and the figures go here, in the repair
 * notes, D-441 and D-444). One block for the copies and one for the figures, each a header and a line `items[11]: <detail>`
 * for each place. The notes always fit {@link MAX_REPAIR_NOTES_CHARS}, so the harness never cuts them: lines are dropped whole,
 * last to first, from the block that shows more of them (the figures first when they are equal in number), and the places left without a
 * line are named in a closing line (up to {@link NOTE_PLACES_NAMED}) and counted after that; if even one line of each is too
 * long, the whole text is cut. Everything quoted is the research's (public text the writer was given) or the figure's own
 * digits; of the draft only the position of a place and a figure as written are named. `undefined` when there is no finding.
 */
export function repairNotesV3(copies: readonly NoteFinding[], numbers: readonly NoteFinding[]): string | undefined {
  if (copies.length === 0 && numbers.length === 0) return undefined;
  let copyShown = copies.length;
  let numberShown = numbers.length;
  for (;;) {
    const notes = joined(block(COPY, copies, copyShown), block(NUMBER, numbers, numberShown));
    if (notes.length <= MAX_REPAIR_NOTES_CHARS) return notes;
    // A block keeps at least its first line. Of the two, the one that shows more loses a line first; the figures when equal.
    const copyCan = copyShown > 1;
    const numberCan = numberShown > 1;
    if (numberCan && (!copyCan || numberShown >= copyShown)) numberShown -= 1;
    else if (copyCan) copyShown -= 1;
    else break;
  }
  // One line of each is already too long: keep the head of the notes, never past the limit.
  const only = copies.length === 0 || numbers.length === 0;
  if (only) {
    const kind = copies.length === 0 ? NUMBER : COPY;
    const findings = copies.length === 0 ? numbers : copies;
    return block(kind, findings, 1, Math.max(0, MAX_REPAIR_NOTES_CHARS - block(kind, findings, 1, 0).length));
  }
  return cutToChars(joined(block(COPY, copies, 1), block(NUMBER, numbers, 1)), MAX_REPAIR_NOTES_CHARS);
}
