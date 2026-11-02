/**
 * Numbers written in words, for the rule that a figure in prose must be a passage's own (D-302). A figure in digits is read by
 * `figures.ts`; a figure in words ("one point two five million metres", "a thousand years") says the same thing and must not be a
 * way round that rule. Two things count as a figure here, and only these, so that "one clear example" and "two bulges" stay words:
 *
 * - a magnitude word (hundred, thousand, million, billion, trillion), wherever it stands;
 * - a run of number words that is followed by a unit ("twenty centimetres", "one point two five million metres").
 *
 * Each is stated when some passage holds the same word, or the same run of words, in the same order. Pure.
 */

const MAGNITUDE_WORDS: ReadonlySet<string> = new Set(['hundred', 'thousand', 'million', 'billion', 'trillion']);

const NUMBER_WORDS: ReadonlySet<string> = new Set([
  ...MAGNITUDE_WORDS,
  ...'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety'.split(
    ' ',
  ),
]);

/** Units of length, mass, volume, time, temperature and amount: a number word beside one of these is a measurement. */
const UNITS: ReadonlySet<string> = new Set(
  (
    'metre metres meter meters kilometre kilometres kilometer kilometers centimetre centimetres centimeter centimeters millimetre millimetres millimeter millimeters micron microns nanometre nanometres nanometer nanometers ' +
    'mile miles foot feet inch inches yard yards gram grams kilogram kilograms tonne tonnes ton tons pound pounds litre litres liter liters ' +
    'second seconds minute minutes hour hours day days week weeks month months year years decade decades century centuries millennium millennia ' +
    'degree degrees percent kelvin celsius fahrenheit joule joules watt watts volt volts hertz newton newtons times fold ' +
    'km kg cm mm mph'
  ).split(' '),
);

/** The words of a text, lower case, with a plural magnitude word ("millions") read as its singular. */
function wordsOf(text: string): string[] {
  const words =
    text
      .normalize('NFKC')
      .toLowerCase()
      .match(/\p{L}+|\p{N}+(?:[.,]\p{N}+)*/gu) ?? [];
  return words.map((word) =>
    /^(?:hundred|thousand|million|billion|trillion)s$/u.test(word) ? word.slice(0, -1) : word,
  );
}

const isNumberWord = (word: string | undefined): boolean => word !== undefined && NUMBER_WORDS.has(word);
const isMagnitude = (word: string | undefined): boolean => word !== undefined && MAGNITUDE_WORDS.has(word);

/** Whether the word after a run is a unit; "light" counts when a unit of time follows it ("light years"). */
function isUnit(word: string | undefined, after: string | undefined): boolean {
  if (word === undefined) return false;
  return UNITS.has(word) || (word === 'light' && after !== undefined && UNITS.has(after));
}

/** Whether `needle` stands in `words` as a run, in order. */
function holdsRun(words: readonly string[], needle: readonly string[]): boolean {
  for (let start = 0; start + needle.length <= words.length; start += 1)
    if (needle.every((word, offset) => words[start + offset] === word)) return true;
  return false;
}

/**
 * The runs of number words in `words`, each with the word that follows it. A run is number words in a row, joined by "point" or
 * "and" when number words stand on both sides of it, and begun by "a" or "an" when a magnitude word follows ("a million").
 */
function numberRuns(words: readonly string[]): { readonly run: readonly string[]; readonly next: number }[] {
  const runs: { readonly run: readonly string[]; readonly next: number }[] = [];
  let at = 0;
  while (at < words.length) {
    const article = (words[at] === 'a' || words[at] === 'an') && isMagnitude(words[at + 1]);
    if (!article && !isNumberWord(words[at])) {
      at += 1;
      continue;
    }
    const start = at;
    let end = article ? at + 1 : at;
    while (end < words.length) {
      const joins = (words[end] === 'point' || words[end] === 'and') && isNumberWord(words[end - 1]);
      if (isNumberWord(words[end]) || (joins && isNumberWord(words[end + 1]))) end += 1;
      else break;
    }
    runs.push({ run: words.slice(start, end), next: end });
    at = end;
  }
  return runs;
}

/**
 * The numbers written in words in `text` that no passage writes: each magnitude word the passages never use, and each run of number
 * words with a unit after it that no passage holds in the same words, in the order of the text and without repeats.
 */
export function unstatedSpelledFigures(text: string, passages: readonly string[]): readonly string[] {
  const written = wordsOf(text);
  const known = passages.map(wordsOf);
  const unstated = new Set<string>();
  for (const word of written) if (isMagnitude(word) && !known.some((words) => words.includes(word))) unstated.add(word);
  for (const { run, next } of numberRuns(written)) {
    if (!isUnit(written[next], written[next + 1])) continue;
    // "a million" and "million" are the same number; the article is not part of what a passage must hold.
    const bare = run[0] === 'a' || run[0] === 'an' ? run.slice(1) : run;
    if (!known.some((words) => holdsRun(words, bare))) unstated.add(run.join(' '));
  }
  return [...unstated];
}
