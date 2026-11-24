import type { Magnitude } from '../../v2/blocks.js';
import {
  plainFigure,
  pointAgrees,
  readingsOf,
  unitWordsNotIn,
  unstatedFigures,
  type Occurrence,
  type Reading,
} from '../figures.js';
import type { NamedText } from './copy-detail.js';

/** The most figures of one finding that the detail names; the others are counted. */
export const NUMBER_DETAIL_FIGURES = 3;
/** The most passage ids the detail names for one figure; a fourth is left out. */
export const NUMBER_DETAIL_PASSAGES = 3;
/** The words of a passage the detail quotes around a figure: this many before it and this many after it. */
const WINDOW_BEFORE = 3;
const WINDOW_AFTER = 2;

/** An offered passage as the writer sees it: the handle it cites (`e11`) and the research's own text. */
export interface PassageText {
  readonly handle: string;
  readonly text: string;
}

/**
 * Whom the figure was judged against: the passages one part cites (`part`), or every passage the whole Scroll cites
 * (`scroll`, for the title, the dek, a section title and an ask suggestion).
 */
export type NumberScope = 'part' | 'scroll';

const DIGITS = /^-?\d/u;

/** Whether `passage` is one of the passages cited (the same offered passage, by its handle). */
const isIn = (passage: PassageText, list: readonly PassageText[]): boolean =>
  list.some((entry) => entry.handle === passage.handle);

/** The words of the research around the figure at `index` of `text`, as the research writes them: at most {@link WINDOW_BEFORE} before and {@link WINDOW_AFTER} after. */
function windowAround(text: string, index: number): string {
  const words = [...text.matchAll(/\S+/gu)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
  const at = words.findIndex((word) => word.end > index);
  if (at < 0) return '';
  const first = Math.max(0, at - WINDOW_BEFORE);
  const last = Math.min(words.length - 1, at + WINDOW_AFTER);
  const from = words[first]?.start ?? 0;
  const to = words[last]?.end ?? text.length;
  const cut = text.slice(from, to).trim().replaceAll('"', "'");
  return `${first > 0 ? '… ' : ''}${cut}${last < words.length - 1 ? ' …' : ''}`;
}

/** `e3`, `e3 or e5`, `e3, e5 or e9`: the handles of passages, at most {@link NUMBER_DETAIL_PASSAGES}. */
function listOf(handles: readonly string[]): string {
  const shown = handles.slice(0, NUMBER_DETAIL_PASSAGES);
  const last = shown.at(-1) ?? '';
  return shown.length < 2 ? last : `${shown.slice(0, -1).join(', ')} or ${last}`;
}

/** The pair of figures that make up one range of a passage, the same whichever end is asked about. */
const rangeKey = (handle: string, figure: string, otherEnd: string): string =>
  `${handle}:${[figure.replace(/^-/u, ''), otherEnd].sort().join('~')}`;

/**
 * How a passage writes a figure that a part writes another way, in words the writer can act on. The second end of a range
 * that an earlier sentence of the same detail already showed (`shown`) says only that it is the other end.
 */
function otherWay(
  figure: string,
  passage: PassageText,
  reading: Occurrence,
  quote: string,
  shown: Set<string>,
): string {
  if (reading.otherEnd !== undefined) {
    const key = rangeKey(passage.handle, figure, reading.otherEnd);
    if (shown.has(key)) return 'is the other end of the same range: write the two together';
    shown.add(key);
    return `is in ${passage.handle}, but only as one end of a range ("${quote}"): a range counts only whole, so write both ends together, in the order the passage does, or say the figure in words`;
  }
  const lead = `is in ${passage.handle}, but`;
  if (reading.reading === 'unknown')
    return `${lead} written as "${quote}", a form a figure cannot take: say it in words`;
  if (reading.reading !== 'bare')
    return `${lead} with the word "${reading.reading}" after it ("${quote}"): write it with that word, or say it in words`;
  return `${lead} written another way ("${quote}"): write it exactly as the passage does (the same digits, the same word after it, the same sign), or say it in words`;
}

/** The first occurrence of the digits of `figure` in the passages, with the passage and the research's words around it. */
function firstOccurrence(
  figure: string,
  passages: readonly PassageText[],
): { readonly passage: PassageText; readonly reading: Occurrence; readonly quote: string } | undefined {
  const digits = figure.replace(/^-/u, '');
  for (const passage of passages) {
    const [reading] = readingsOf(digits, [passage.text]);
    if (reading !== undefined) return { passage, reading, quote: windowAround(passage.text, reading.index) };
  }
  return undefined;
}

/** What is wrong with one figure of a text and where the research has it right: the verdict, as one sentence without its subject. */
function verdictOf(
  figure: string,
  holders: readonly PassageText[],
  cited: readonly PassageText[],
  offered: readonly PassageText[],
  scope: NumberScope,
  shown: Set<string>,
): string {
  if (holders.length > 0) {
    const ids = listOf(holders.map((passage) => passage.handle));
    return scope === 'scroll'
      ? `is in ${ids}, which no part of the Scroll cites: cite ${ids} in a part of the Scroll, or take the figure out of this text`
      : `is not in the passages this part cites, but ${ids} states it that way: cite ${ids}`;
  }
  if (DIGITS.test(figure)) {
    const inCited = firstOccurrence(figure, cited);
    if (inCited !== undefined) return otherWay(figure, inCited.passage, inCited.reading, inCited.quote, shown);
    const elsewhere = firstOccurrence(
      figure,
      offered.filter((passage) => !isIn(passage, cited)),
    );
    if (elsewhere !== undefined)
      return `is not in the passages cited here; ${otherWay(figure, elsewhere.passage, elsewhere.reading, elsewhere.quote, shown).replace(/^is in (\S+), but/u, '$1 has it, but')}`;
  }
  return 'is in none of the offered passages, so it is not in the research: take it out, or use a figure a passage states';
}

/** The most characters of the model's own text that a detail repeats for one figure or unit: a figure is digits or number words, short. */
const MOST_QUOTED_CHARS = 40;

/** A figure (or a unit) as the part writes it, for the sentence: `"54"`, cut to {@link MOST_QUOTED_CHARS}. */
const quoted = (text: string): string =>
  `"${(text.length > MOST_QUOTED_CHARS ? `${text.slice(0, MOST_QUOTED_CHARS - 1)}…` : text).replaceAll('"', "'")}"`;

/**
 * What the repair is told about the figures of a part of the reply that no cited passage states the way the part writes
 * them (`authoring_number_not_in_evidence`, D-444): for each figure the part of the item it stands in and the figure as
 * written, and then one of three things. If an offered passage the part does not cite states it, the passages' ids (`cite
 * e11`). If a passage it does cite has the digits but writes them another way, how: as one end of a range (and the
 * research's own words around it), with a magnitude word after it, or in a form a figure cannot take. If no offered passage
 * has it, that it is not in the research, to take out or replace. The rule that decides what is stated is `unstatedFigures`,
 * unchanged. Built from the research's words and the figure as the model wrote it; the research's words are a public page
 * the writer was given. The first {@link NUMBER_DETAIL_FIGURES} figures are named, the others counted; `undefined` when every
 * figure of the fields is stated.
 *
 * The harness's own repair catalogue is static, so, like the copy detail (`copyDetailV3`), this rides in the repair notes.
 */
export function numberDetailOfTexts(
  fields: readonly NamedText[],
  cited: readonly PassageText[],
  offered: readonly PassageText[],
  scope: NumberScope = 'part',
): string | undefined {
  const byFigure = new Map<string, string[]>();
  for (const { field, text } of fields)
    for (const figure of unstatedFigures(
      text,
      cited.map((passage) => passage.text),
    )) {
      const named = byFigure.get(figure) ?? [];
      if (!named.includes(field)) named.push(field);
      byFigure.set(figure, named);
    }
  if (byFigure.size === 0) return undefined;
  const shown = new Set<string>();
  const sentences = [...byFigure].map(([figure, names]) => {
    const text = fields.find((entry) => names.includes(entry.field))?.text ?? '';
    const holders = offered.filter(
      (passage) => !isIn(passage, cited) && !unstatedFigures(text, [passage.text]).includes(figure),
    );
    return `In the ${names.join(' and the ')}, ${quoted(figure)} ${verdictOf(figure, holders, cited, offered, scope, shown)}.`;
  });
  const rest = sentences.length - NUMBER_DETAIL_FIGURES;
  return [
    ...sentences.slice(0, NUMBER_DETAIL_FIGURES),
    ...(rest > 0 ? [`(${String(rest)} more ${rest === 1 ? 'figure' : 'figures'} not shown.)`] : []),
  ].join(' ');
}

/** What a chart point's value is written with: the magnitude word its unit opens with, if any. */
export interface ChartValue {
  readonly value: string;
  readonly magnitude: Magnitude | undefined;
  /** The values of the whole chart, as plain figures: a range's other end may be one of them. */
  readonly values: ReadonlySet<string>;
}

const wanted = (point: ChartValue): Reading => point.magnitude ?? 'bare';

/** The compile's own rule for a chart value (`pointAgrees`): the passages state the figure, and state it the way the chart writes it. */
const agreesWith = (point: ChartValue, passages: readonly string[]): boolean =>
  readingsOf(plainFigure(point.value), passages).length > 0 &&
  pointAgrees({ value: point.value, magnitude: point.magnitude }, passages, point.values);

/** How a passage writes a chart value that does not agree with it, as a sentence that names the fix. */
function chartOtherWay(point: ChartValue, quote: string, reading: Occurrence): string {
  const aim = wanted(point);
  if (reading.otherEnd !== undefined && !point.values.has(reading.otherEnd))
    return `only as one end of a range ("${quote}"): a chart value that ends a range passes only when the other end (${quoted(reading.otherEnd)}) is also one of the chart's values; if the other end is not something the chart plots (a year, a count), leave this point out and say the figure in words`;
  if (reading.reading === 'unknown')
    return `written as "${quote}", a form a chart value cannot take: leave the point out and say the figure in words`;
  if (reading.reading !== aim)
    return reading.reading === 'bare'
      ? `without the word "${String(aim)}" after it ("${quote}"): the unit must not open with "${String(aim)}"`
      : `with the word "${reading.reading}" after it ("${quote}"): the unit must open with "${reading.reading}", and the value stays as the passage writes it`;
  return `written another way ("${quote}"): the value must be the digits exactly as the passage writes them`;
}

/**
 * The detail of a chart value that a cited passage does not state the way a chart can show it (`pictures.N.points.K.value`):
 * the same three cases as {@link numberDetailOfTexts}, and, for a value a cited passage has but writes another way, what the
 * chart's unit or other values must be. `label` names the point ("point 2"). `undefined` when the value agrees.
 */
export function numberDetailOfValue(
  label: string,
  point: ChartValue,
  cited: readonly PassageText[],
  offered: readonly PassageText[],
): string | undefined {
  const figure = plainFigure(point.value);
  if (
    agreesWith(
      point,
      cited.map((passage) => passage.text),
    )
  )
    return undefined;
  const holders = offered.filter((passage) => !isIn(passage, cited) && agreesWith(point, [passage.text]));
  const subject = `The value of ${label}, ${quoted(point.value)},`;
  if (holders.length > 0) {
    const ids = listOf(holders.map((passage) => passage.handle));
    return `${subject} is not in the passages this chart cites, but ${ids} states it that way: cite ${ids}.`;
  }
  const inCited = firstOccurrence(figure, cited);
  if (inCited !== undefined) {
    // Of the ways the cited passages write it, the one that is nearest to what the chart can show.
    const near =
      readingsOf(figure, [inCited.passage.text]).find((entry) => entry.reading === wanted(point)) ?? inCited.reading;
    return `${subject} is in ${inCited.passage.handle}, but ${chartOtherWay(point, windowAround(inCited.passage.text, near.index), near)}.`;
  }
  const elsewhere = firstOccurrence(
    figure,
    offered.filter((passage) => !isIn(passage, cited)),
  );
  if (elsewhere !== undefined)
    return `${subject} is not in the passages this chart cites; ${elsewhere.passage.handle} has it, but ${chartOtherWay(point, elsewhere.quote, elsewhere.reading)}.`;
  return `${subject} is in none of the offered passages, so it is not in the research: leave the point out, or use a figure a passage states.`;
}

/**
 * The detail of a chart unit that has a word no cited passage writes (`pictures.N.unit`). The value finding and the unit
 * finding are different faults, and the repair is told which of them it is: a model that read only "a chart value and its
 * unit must match" changed a unit that was right (D-444). `undefined` when every word of the unit is in a cited passage.
 */
export function numberDetailOfUnit(
  unit: string,
  cited: readonly PassageText[],
  offered: readonly PassageText[],
): string | undefined {
  const missing = unitWordsNotIn(
    unit,
    cited.map((passage) => passage.text),
  );
  if (missing.length === 0) return undefined;
  const words = missing.map(quoted).join(', ');
  const subject = `The unit ${quoted(unit)} has ${missing.length === 1 ? 'a word' : 'words'} that no passage this chart cites writes: ${words}.`;
  const holders = offered.filter(
    (passage) => !isIn(passage, cited) && unitWordsNotIn(unit, [passage.text]).length < missing.length,
  );
  const sign = cited.some((passage) => passage.text.includes('%')) ? ' (the passages write the sign "%")' : '';
  const where =
    holders.length > 0
      ? ` ${listOf(holders.map((passage) => passage.handle))} writes ${missing.length === 1 ? 'it' : 'some of them'}: cite it, or use a unit in the words of a cited passage${sign}.`
      : ` Use a unit made of the words of a cited passage${sign}; the unit is not a figure and the values do not change.`;
  return `${subject}${where}`;
}
