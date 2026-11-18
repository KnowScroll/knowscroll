/** The longest piece of the selected words that is echoed back into the question draft. */
const PASSAGE_LIMIT = 90;

/** The selected words as one line of a sensible length; empty when nothing but space was selected. */
export function passageOf(selected: string): string {
  const line = selected.replace(/\s+/gu, ' ').trim();
  const letters = [...line];
  return letters.length <= PASSAGE_LIMIT ? line : `${letters.slice(0, PASSAGE_LIMIT - 1).join('')}…`;
}
