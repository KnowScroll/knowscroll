import { MAX_REPAIR_NOTES_CHARS } from '../../../reasoning/public.js';

/** The most places with no room for their line that are named in the closing line; the others are counted. */
export const COPY_NOTE_PLACES = 12;

/** A copy finding of the document v3 compile: where it is in the model's reply, and what it says about the copy (`copyDetailV3`). */
export interface CopyFinding {
  /** The model's own path (`items.11`, `pictures.0`, `items.8.title`). */
  readonly path: string;
  /** The part and the research's words, from the compile; never words the model wrote. */
  readonly detail: string;
}

const HEADER =
  'Each line names an item of your answer, the part of it that repeats the research, and the words that match (lower case, no punctuation). Rebuild each sentence that holds them in your own words: keep its key terms, but change the order of the ideas and the shape of the sentence, not only a word or two. Keep every other sentence as it is.';

/** The path as the model's JSON reads it: `items.11` is `items[11]`. */
const placeOf = (path: string): string => path.replace(/\.(\d+)/gu, '[$1]');

/** `text` cut to at most `max` characters, ending in an ellipsis, never between the halves of a surrogate pair. */
function cutToChars(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = Math.max(0, max - 1);
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end).trimEnd()}…`;
}

/** The places that have no line among the shown ones: named by reference up to {@link COPY_NOTE_PLACES}, then counted. */
function unnamedLine(unnamed: readonly CopyFinding[]): readonly string[] {
  if (unnamed.length === 0) return [];
  const names = unnamed.slice(0, COPY_NOTE_PLACES).map((finding) => placeOf(finding.path));
  const rest = unnamed.length - names.length;
  return [`Also copying: ${names.join(', ')}${rest > 0 ? ` and ${String(rest)} more` : ''}.`];
}

function render(findings: readonly CopyFinding[], shown: number, cutLine?: number): string {
  const lines = findings
    .slice(0, shown)
    .map((finding) => `${placeOf(finding.path)}: ${finding.detail}`)
    .map((line, index) => (index === 0 && cutLine !== undefined ? cutToChars(line, cutLine) : line));
  return [HEADER, ...lines, ...unnamedLine(findings.slice(shown))].join('\n');
}

/**
 * What the writer's one repair is told about a draft refused for `copied_passage` (the harness's catalogue is static and holds
 * one fixed hint per code, so the part and the words go here, in the repair notes): for each place in the model's reply, the
 * part of it that copies and the research's words that it copies (`copyDetailV3`). A line is the place and the compile's own
 * sentence. The notes always fit {@link MAX_REPAIR_NOTES_CHARS}, so the harness never cuts them: lines are dropped whole, last
 * to first, and the places left without a line are named in a closing line (up to {@link COPY_NOTE_PLACES}) and counted after
 * that; if even one line is too long, it is cut to the room the rest leaves. Everything quoted is the research's (public text
 * the writer was given); of the draft only the position of a place is named. `undefined` when there is no copy finding.
 */
export function copyRepairNotesV3(findings: readonly CopyFinding[]): string | undefined {
  if (findings.length === 0) return undefined;
  for (let shown = findings.length; shown >= 1; shown -= 1) {
    const notes = render(findings, shown);
    if (notes.length <= MAX_REPAIR_NOTES_CHARS) return notes;
  }
  const room = Math.max(0, MAX_REPAIR_NOTES_CHARS - render(findings, 1, 0).length);
  return render(findings, 1, room);
}
