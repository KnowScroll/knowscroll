import { countWords } from '../text.js';
import type { AsideV3, Beat, MeasuresV3, SectionV3 } from './document.js';
import { SCROLL_MEASURES_V3_VERSION } from './document.js';

/**
 * `scroll-measures.v3`: every word a reader reads (beats, asides, the takeaway) at 230 words a minute, plus four
 * seconds to look at each figure a beat shows and ten for each control, which must land between two and four minutes
 * (decision J). Words alone would make a 400-word essay about 1.7 minutes; the pictures are part of the reading. A
 * change is a new measures version; v1 and v2 measures are untouched.
 */
export const WORDS_PER_MINUTE_V3 = 230;
export const SECONDS_PER_FIGURE = 4;
export const SECONDS_PER_CONTROL = 10;
export const READING_SECONDS_V3 = { min: 120, max: 240 } as const;

/** The words of one beat as read on the way through. The plainer words are shown on request and are not counted. */
export const beatWords = (beat: Pick<Beat, 'text'>): number => countWords(beat.text);

const asideWords = (aside: Pick<AsideV3, 'title' | 'text'>): number => countWords(aside.title) + countWords(aside.text);

interface MeasuredParts {
  readonly sections: readonly Pick<SectionV3, 'beats'>[];
  readonly asides: readonly Pick<AsideV3, 'title' | 'text' | 'anchorBeat'>[];
  readonly takeaway: string;
}

/** Reading measures of a document v3's beats, asides and takeaway. An aside weighs with the beat it sits beside. */
export function computeMeasuresV3(parts: MeasuredParts): MeasuresV3 {
  const beats = parts.sections.flatMap((section) => section.beats);
  const weights = beats.map((beat) => ({
    beatId: beat.id,
    weight:
      beatWords(beat) +
      parts.asides.filter((aside) => aside.anchorBeat === beat.id).reduce((total, aside) => total + asideWords(aside), 0),
  }));
  const mainWords = beats.reduce((total, beat) => total + beatWords(beat), 0);
  const words =
    mainWords + parts.asides.reduce((total, aside) => total + asideWords(aside), 0) + countWords(parts.takeaway);
  const figures = beats.filter((beat) => beat.show !== undefined).length;
  const controls = beats.filter((beat) => beat.kind === 'plain' && beat.control !== undefined).length;
  const readingSeconds =
    Math.round((words * 60) / WORDS_PER_MINUTE_V3) + figures * SECONDS_PER_FIGURE + controls * SECONDS_PER_CONTROL;
  return {
    version: SCROLL_MEASURES_V3_VERSION,
    readingSeconds: Math.max(1, readingSeconds),
    readingMinutes: Math.max(0.1, Math.round(readingSeconds / 6) / 10),
    mainWords,
    totalWeight: weights.reduce((total, beat) => total + beat.weight, 0),
    beats: weights,
  };
}
