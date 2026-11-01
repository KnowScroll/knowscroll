import { countWords } from '../text.js';
import { interactiveWords } from './blocks.js';
import type { Aside, MeasuresV2, Recap, Stop } from './document.js';
import { SCROLL_MEASURES_V2_VERSION } from './document.js';

/**
 * `scroll-measures.v2`: reading time at 230 words a minute plus ten seconds for every call, which
 * must land between three and six minutes. A change is a new measures version; v1 measures
 * (`WORDS_PER_MINUTE = 200`) are untouched.
 */
export const WORDS_PER_MINUTE_V2 = 230;
export const SECONDS_PER_CALL = 10;
/** A sort, a fork, a scale or a chart takes about as long to play as a call (D-207). */
export const SECONDS_PER_INTERACTIVE = 10;
export const READING_SECONDS_V2 = { min: 180, max: 360 } as const;

/** What ten seconds of thinking weighs in word-equivalents. */
const CALL_WEIGHT = Math.round((WORDS_PER_MINUTE_V2 * SECONDS_PER_CALL) / 60);

/**
 * The words a reader reads on the way through one stop. A `simple` text is shown on request and is
 * not counted. A twist is shown only after a wrong pick but is counted: the estimate is for the
 * longer path.
 */
export function stopWords(stop: Stop): number {
  if (stop.kind === 'read')
    return (
      stop.blocks.reduce((total, block) => total + countWords(block.text), 0) +
      (stop.interactive === undefined ? 0 : interactiveWords(stop.interactive)) +
      (stop.guide === undefined ? 0 : countWords(stop.guide.line))
    );
  return [stop.prompt, ...stop.options, stop.explain, stop.twist].reduce((total, text) => total + countWords(text), 0);
}

/** Weight of a stop in word-equivalents: its words, and for a call the ten seconds it takes. */
export function stopWeight(stop: Stop): number {
  return stopWords(stop) + (stop.kind === 'read' ? 0 : CALL_WEIGHT);
}

const asideWords = (aside: Pick<Aside, 'title' | 'text'>): number => countWords(aside.title) + countWords(aside.text);

interface MeasuredParts {
  readonly stops: readonly Stop[];
  readonly asides: readonly Pick<Aside, 'title' | 'text' | 'anchorStop'>[];
  readonly recap: Pick<Recap, 'captions'>;
}

/** The words a reader reads in all: stops, asides and the recap. A call's ten seconds are not words. */
export function readingWords(parts: MeasuredParts): number {
  return (
    parts.stops.reduce((total, stop) => total + stopWords(stop), 0) +
    parts.asides.reduce((total, aside) => total + asideWords(aside), 0) +
    parts.recap.captions.reduce((total, caption) => total + countWords(caption), 0)
  );
}

/** Reading measures of a Scroll's stops, asides and recap. Asides count with the stop they open next to. */
export function computeMeasuresV2(parts: MeasuredParts): MeasuresV2 {
  const stops = parts.stops.map((stop) => ({
    stopId: stop.id,
    weight:
      stopWeight(stop) +
      parts.asides
        .filter((aside) => aside.anchorStop === stop.id)
        .reduce((total, aside) => total + asideWords(aside), 0),
  }));
  const recapWeight = parts.recap.captions.reduce((total, caption) => total + countWords(caption), 0);
  const totalWeight = stops.reduce((total, stop) => total + stop.weight, 0) + recapWeight;
  const calls = parts.stops.filter((stop) => stop.kind !== 'read').length;
  const interactives = parts.stops.filter((stop) => stop.kind === 'read' && stop.interactive !== undefined).length;
  const readingSeconds =
    Math.round((readingWords(parts) * 60) / WORDS_PER_MINUTE_V2) +
    calls * SECONDS_PER_CALL +
    interactives * SECONDS_PER_INTERACTIVE;
  return {
    version: SCROLL_MEASURES_V2_VERSION,
    readingSeconds: Math.max(1, readingSeconds),
    readingMinutes: Math.max(0.1, Math.round(readingSeconds / 6) / 10),
    totalWeight,
    recapWeight,
    stops,
  };
}
