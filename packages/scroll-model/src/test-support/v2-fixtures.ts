import type { AuthoringEvidence } from '../producer/authoring-bind.js';
import { AuthoredScrollV2 } from '../producer/v2/authoring-schema.js';
import type { PublicationV2, RecipeDataV2 } from '../producer/v2/assemble.js';
import type { CompileV2Input } from '../producer/v2/compile.js';
import type { Misconception } from '../v2/document.js';

/**
 * CI FIXTURES for `scroll-document.v2`, never product content. The evidence is a few authored
 * sentences about an invented planet; the stop texts are generated filler of invented words, so that
 * no run of nine words can match the evidence and the reading time lands where the tests need it.
 */
export const PASSAGES_V2 = [
  'Orrin’s axis leans by 31 degrees, and the lean points the same way all year while the planet circles its star Vael.',
  'When Orrin’s northern half leans toward Vael, sunlight there arrives steeply and days run long, so the north warms.',
  'Half an orbit later the lean points away from Vael, sunlight arrives at a low angle and the northern days shorten.',
  'Orrin passes nearest to Vael in the middle of its southern summer, and its closest and farthest distances differ by only a few percent.',
  'A beam of light that strikes the ground at a low angle spreads over a wider patch, so each square metre receives less energy.',
  'Near the equator the noon sun stays high in every season, so the tropics change far less across the year than the poles do.',
];

const claimIds = PASSAGES_V2.map((_, index) => `claim-v2-${index + 1}`);
export const EVIDENCE_V2: AuthoringEvidence = {
  claimIdOf: new Map(claimIds.map((id, index) => [`e${index + 1}`, id])),
  quoteOf: new Map(claimIds.map((id, index) => [id, PASSAGES_V2[index] ?? ''])),
  minDistinctCitations: 4,
};

export const PUBLICATION_V2: PublicationV2 = {
  assetId: 'fixture-orrin-seasons',
  revision: 1,
  language: 'en',
  explanationUnitId: 'fixture-orrin-seasons-unit',
  kicker: 'A closer look',
  framing: { kind: 'factual' },
  themeFamily: 'worlds',
};

export const MYTH_V2 = {
  kind: 'myth',
  claim: 'Orrin is warmest because it is closest to its star.',
  source: { label: 'CI fixture label', reviewed: true },
} as const satisfies Misconception;

export const recipeV2 = (variant: 'stage' | 'plain', misconception: Misconception = MYTH_V2): RecipeDataV2 => ({
  variant,
  misconception,
});

const WORDS = [
  'amber',
  'harbour',
  'lantern',
  'copper',
  'meadow',
  'quarry',
  'beacon',
  'willow',
  'ferry',
  'granite',
  'orchard',
  'saddle',
  'thistle',
  'anchor',
  'bramble',
  'cinder',
  'drizzle',
  'ember',
  'fennel',
  'gable',
  'hollow',
  'ivory',
  'juniper',
  'kettle',
  'linen',
  'mantle',
  'nettle',
  'oakum',
  'pewter',
  'quilt',
];

/** `count` invented words in sentences of nine to eleven words; `tag` makes each text different. */
export function filler(count: number, tag: number): string {
  const sentences: string[] = [];
  let words: string[] = [];
  for (let at = 0; at < count; at += 1) {
    words.push(WORDS[(at * 7 + tag * 13) % WORDS.length] ?? 'amber');
    if (words.length === 9 + (at % 3) || at === count - 1) {
      const sentence = words.join(' ');
      sentences.push(`${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`);
      words = [];
    }
  }
  return sentences.join(' ');
}

/**
 * `count` invented words that no other `tag` shares, in letters only so that no figure appears. The
 * call questions and options use them: `filler` cycles through thirty words, so two filler
 * questions would restate one another and the Final call would be refused (D-126).
 */
export function distinct(count: number, tag: number): string {
  const letters = (value: number): string => {
    let rest = value;
    let out = '';
    do {
      out = String.fromCharCode(97 + (rest % 26)) + out;
      rest = Math.floor(rest / 26);
    } while (rest > 0);
    return out;
  };
  return Array.from({ length: count }, (_, at) => `zq${letters(tag * 100 + at)}`).join(' ');
}

const patch = (tag: number) => ({ earthAt: (['jan', 'mar', 'jun', 'sep', 'dec', 'feb', 'may'] as const)[tag % 7] });

/**
 * A valid authored Scroll: eight stops, two Call its and a Final call, a limits aside after stop
 * seven, a recap and questions. About 700 words, so about three and a half minutes to read.
 * `variant: 'plain'` leaves the stage out. Only stops change the picture, never a call, and the
 * first Call it's second option is the common guess (D-126).
 */
export function authoredV2(variant: 'stage' | 'plain' = 'stage'): AuthoredScrollV2 {
  const stageFor = (tag: number, first = false) =>
    variant === 'stage' ? { stage: first ? { view: 'sun-earth' as const, ...patch(tag) } : patch(tag) } : {};
  const stop = (tag: number, cites: string[], first = false) => ({
    type: 'stop' as const,
    cites,
    text: filler(52, tag),
    simple: filler(24, tag + 40),
    ...stageFor(tag, first),
  });
  const call = (tag: number, type: 'call_it' | 'final_call', cites: string[], extra: object = {}) => ({
    type,
    cites,
    prompt: `Which of these ${distinct(8, tag)}?`,
    options: [distinct(6, tag * 10 + 1), distinct(6, tag * 10 + 2), distinct(6, tag * 10 + 3)],
    explain: filler(36, tag + 4),
    twist: filler(26, tag + 5),
    simple: filler(20, tag + 6),
    ...extra,
  });
  return AuthoredScrollV2.parse({
    title: 'Why Orrin has summers and winters',
    dek: 'A planet that leans and a guess that most people get wrong, told in short steps.',
    items: [
      stop(1, ['e1', 'e2'], true),
      call(2, 'call_it', ['e1', 'e4']),
      stop(3, ['e4']),
      stop(4, ['e1', 'e3']),
      call(5, 'call_it', ['e3', 'e5']),
      stop(6, ['e2', 'e5']),
      stop(7, ['e3', 'e5']),
      stop(8, ['e6']),
      {
        type: 'aside',
        cites: ['e6'],
        kind: 'limits',
        title: 'Where this stops',
        text: filler(30, 9),
      },
      call(10, 'final_call', ['e1', 'e5']),
    ],
    recap: { cites: ['e1', 'e5'], captions: [filler(8, 11), filler(8, 12), filler(8, 13)] },
    askSuggestions: ['What would a planet tipped on its side be like?', 'Why do the tropics have so few seasons?'],
  });
}

/** The compile input for the fixtures above. */
export function compileInputV2(
  variant: 'stage' | 'plain' = 'stage',
  misconception: Misconception = MYTH_V2,
): CompileV2Input {
  return {
    publication: PUBLICATION_V2,
    recipe: recipeV2(variant, misconception),
    evidence: EVIDENCE_V2,
    sources: PASSAGES_V2,
  };
}
