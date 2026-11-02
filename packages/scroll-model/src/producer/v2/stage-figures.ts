import type { ScrollDocumentV2 } from '../../v2/document.js';
import type { IssueV2 } from '../../v2/issues.js';
import { EARTH_SKY_KIT, recapMonths, type StageFigureSlot } from '../../v2/kit.js';
import type { AuthoringEvidence } from '../authoring-bind.js';
import { isFigure, type StagePlanV2 } from './assemble.js';
import type { AuthoredScrollV2, AuthoredStageFigure } from './authoring-schema.js';
import { numericTokens } from '../../text.js';
import { plainFigure, readingsOf, type Reading } from './figures.js';

/**
 * What a passage must say beside a figure for the figure to belong to its slot (D-382): the word that names the end of the
 * orbit, or the month. A passage often gives two figures with two such words, in either order ("in June ... 14 hours ... in
 * December ... 10 hours", "Delhi gets 14 hours of daylight in June and 10 hours in December"), so each cue word is given to a
 * figure of its own clause when there is one (a clause ends at a comma, a semicolon or a sentence end, and at "and", "while",
 * "but"), and otherwise to the figure it stands nearest to. A figure belongs to the slot most of its cue words name. A figure
 * whose cue words are tied, or are none, belongs to no slot, so a pair given the wrong way round is not stated.
 */
const SLOT_CUES: Readonly<Record<StageFigureSlot, RegExp>> = {
  nearest: /\b(?:nearest|closest|nearer|perihelion)\b/giu,
  farthest: /\b(?:farthest|furthest|aphelion|most distant)\b/giu,
  'june-daylight': /\bjune\b/giu,
  'december-daylight': /\bdecember\b/giu,
};

/** The slots whose cue words compete for a figure. */
const FAMILY: Readonly<Record<StageFigureSlot, readonly StageFigureSlot[]>> = {
  nearest: ['nearest', 'farthest'],
  farthest: ['nearest', 'farthest'],
  'june-daylight': ['june-daylight', 'december-daylight'],
  'december-daylight': ['june-daylight', 'december-daylight'],
};

/** How far from a figure a cue word, or a place name, may stand to count for it, in characters. */
const CUE_REACH = 120;

/** What ends a clause: a semicolon or colon, a sentence end, a comma before a space (never one inside `91,400,000`), and a joining word. */
const CLAUSE_END = /[;:]|[.!?](?=\s|$)|,(?=\s)|\s(?:and|while|whereas|whilst|but)\s/giu;

/** The clause a position is in: how many clause ends come before it. */
const clauseAt = (ends: readonly number[], position: number): number => ends.filter((end) => end <= position).length;

/** The gap in characters between a span and a word that does not overlap it. */
const gapBetween = (start: number, end: number, otherStart: number, otherEnd: number): number =>
  otherEnd <= start ? start - otherEnd : Math.max(0, otherStart - end);

/** The slot most of the cue words that stand nearest to the figure at `index` of `text` name, or none when they are tied or absent. */
function slotNear(text: string, index: number, family: readonly StageFigureSlot[]): StageFigureSlot | undefined {
  const numbers = numericTokens(text);
  const own = numbers.findIndex(([start, end]) => index >= start && index < end);
  if (own < 0) return undefined;
  const ends = [...text.matchAll(CLAUSE_END)].map((match) => match.index + match[0].length);
  const votes = new Map<StageFigureSlot, number>();
  for (const slot of family)
    for (const cue of text.matchAll(SLOT_CUES[slot])) {
      const cueEnd = cue.index + cue[0].length;
      const candidates = numbers.map(([start, end], at) => ({
        at,
        gap: gapBetween(start, end, cue.index, cueEnd),
        together: clauseAt(ends, start) === clauseAt(ends, cue.index),
      }));
      // A figure in the cue's own clause takes it; with none there, the nearest figure of the passage does.
      const pool = candidates.some((candidate) => candidate.together)
        ? candidates.filter((candidate) => candidate.together)
        : candidates;
      const nearest = pool.reduce((best, candidate) => (candidate.gap < best.gap ? candidate : best));
      if (nearest.at === own && nearest.gap <= CUE_REACH) votes.set(slot, (votes.get(slot) ?? 0) + 1);
    }
  const ranked = [...votes].sort((first, second) => second[1] - first[1]);
  return ranked[0] !== undefined && ranked[0][1] > (ranked[1]?.[1] ?? 0) ? ranked[0][0] : undefined;
}

const MONTHS = new Set([
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
]);

/** Words a place name may hold between its capitalised words ("Stratford upon Avon", "Rio de Janeiro"). */
const PLACE_CONNECTORS = new Set(['of', 'de', 'la', 'le', 'du', 'del', 'upon', 'on', 'the']);

interface Span {
  readonly start: number;
  readonly end: number;
}

/**
 * The names of places a passage could be giving a figure to: each run of capitalised words (a month is no name), and every place
 * where the place the writer gave is written, in any case. The writer's place stands in the list as itself, so a lower-case
 * name is still weighed against the capitalised ones around it.
 */
function placeMentions(text: string, claimed: string): { readonly names: Span[]; readonly claimed: Span[] } {
  const words = [...text.matchAll(/\p{L}[\p{L}'’-]*/gu)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    word: match[0],
  }));
  const names: Span[] = [];
  let run: Span | undefined;
  /** Where a connector word right after the run ends, so that the next capitalised word may join across it. */
  let connectorEnd: number | undefined;
  const close = (): void => {
    if (run !== undefined) names.push(run);
    run = undefined;
    connectorEnd = undefined;
  };
  const spaceBetween = (from: number, to: number): boolean => /^\s+$/u.test(text.slice(from, to));
  for (const entry of words) {
    const capital = /^\p{Lu}/u.test(entry.word) && !MONTHS.has(entry.word.toLowerCase());
    if (capital) {
      const joins =
        run !== undefined &&
        (spaceBetween(run.end, entry.start) || (connectorEnd !== undefined && spaceBetween(connectorEnd, entry.start)));
      if (run !== undefined && joins) run = { start: run.start, end: entry.end };
      else {
        close();
        run = { start: entry.start, end: entry.end };
      }
      connectorEnd = undefined;
    } else if (
      run !== undefined &&
      connectorEnd === undefined &&
      PLACE_CONNECTORS.has(entry.word.toLowerCase()) &&
      spaceBetween(run.end, entry.start)
    )
      connectorEnd = entry.end;
    else close();
  }
  close();
  const wanted = claimed.trim().replace(/\s+/gu, ' ').toLowerCase();
  const lowered = text.toLowerCase();
  const claims: Span[] = [];
  for (let from = lowered.indexOf(wanted); wanted !== '' && from >= 0; from = lowered.indexOf(wanted, from + 1)) {
    const before = lowered.charAt(from - 1);
    const after = lowered.charAt(from + wanted.length);
    if (!/\p{L}/u.test(before) && !/\p{L}/u.test(after)) claims.push({ start: from, end: from + wanted.length });
  }
  const overlaps = (name: Span): boolean => claims.some((claim) => claim.start < name.end && name.start < claim.end);
  return { names: names.filter((name) => !overlaps(name)), claimed: claims };
}

/** Whether the place the writer gave is the name that stands nearest to the figure at `span` of `text`, within reach. */
function placeIsNearest(text: string, span: Span, place: string): boolean {
  const { names, claimed } = placeMentions(text, place);
  const gaps = (spans: readonly Span[]): number[] =>
    spans.map((mention) => gapBetween(span.start, span.end, mention.start, mention.end));
  const own = Math.min(...gaps(claimed), Infinity);
  return own <= CUE_REACH && own <= Math.min(...gaps(names), Infinity);
}

/** The lower-case words of a unit or a stretch of text, a plural s cut off, so "Kilometres" and "kilometre" are one word. */
const unitWords = (text: string): string[] =>
  (text.toLowerCase().match(/\p{L}+/gu) ?? []).map((word) => word.replace(/s$/u, ''));

/**
 * Whether the words right after the figure at `span` of `text` are the unit the writer gave: first the magnitude word the writer
 * gave, if any, then the unit's own words, one for one. A unit that stands elsewhere in the passage (the other half of "91.4 million
 * miles (147.1 million kilometres)") belongs to another figure.
 */
function unitFollows(text: string, span: Span, magnitude: string | undefined, unit: string): boolean {
  const wanted = unitWords(unit);
  if (wanted.length === 0) return false;
  const following = unitWords(
    [...text.slice(span.end).matchAll(/\p{L}+/gu)]
      .slice(0, wanted.length + 1)
      .map((match) => match[0])
      .join(' '),
  );
  const rest = magnitude === undefined ? following : following.slice(1);
  if (magnitude !== undefined && following[0] !== unitWords(magnitude)[0]) return false;
  return wanted.every((word, at) => rest[at] === word);
}

/**
 * Whether the cited passages state a figure of the stage as the figure is written (D-208, D-382). Every part is judged at one place
 * in one passage, the place of the figure itself: its digits with the word the passage puts after them; the unit as the next word
 * after the figure and its magnitude; the word that names its slot standing beside it; and, for a daylight figure, the place name
 * standing nearer to it than any other name. So a unit or a place that the passages hold but that belongs to another figure does not
 * count. A figure the passages write another way (a range end, an exponent, a scaled `8.3m`), and a figure no passage holds, are not stated.
 */
export function stageFigureIsStated(figure: AuthoredStageFigure, quotes: readonly string[]): boolean {
  if (!isFigure(figure.value)) return false;
  const digits = plainFigure(String(figure.value).trim());
  const wanted: Reading = figure.magnitude ?? 'bare';
  const daylight = figure.slot === 'june-daylight' || figure.slot === 'december-daylight';
  if (daylight && figure.place === undefined) return false;
  return quotes.some((quote) => {
    const numbers = numericTokens(quote);
    return readingsOf(digits, [quote]).some((way) => {
      const token = numbers.find(([start, end]) => way.index >= start && way.index < end);
      if (token === undefined) return false;
      const span = { start: token[0], end: token[1] };
      return (
        way.reading === wanted &&
        way.otherEnd === undefined &&
        !way.negative &&
        slotNear(quote, way.index, FAMILY[figure.slot]) === figure.slot &&
        unitFollows(quote, span, figure.magnitude, figure.unit) &&
        (!daylight || placeIsNearest(quote, span, figure.place ?? ''))
      );
    });
  });
}

/** One figure the writer gave that no cited passage states, left out of the picture. */
export interface LeftOutFigure {
  /** The writer's item the figure was written on, as a finding path would name it (`items.3`). */
  readonly path: string;
  readonly slot: StageFigureSlot;
}

/**
 * The authored Scroll with every stage figure that its stop's cited passages do not state taken out, and which they were. The picture then
 * simply has no such figure: code never rounds, converts or fills in a number (D-382), and the writer is not asked to repair
 * what it cannot know, so it costs no request. A slot written twice on a stop keeps its first.
 */
export function leaveOutUnstatedFigures(
  authored: AuthoredScrollV2,
  evidence: AuthoringEvidence,
): { readonly authored: AuthoredScrollV2; readonly leftOut: readonly LeftOutFigure[] } {
  const leftOut: LeftOutFigure[] = [];
  const items = authored.items.map((item, index) => {
    if (item.type !== 'stop' || item.figures === undefined) return item;
    const { figures: written, ...rest } = item;
    const quotes = item.cites.flatMap((handle) => {
      const claimId = evidence.claimIdOf.get(handle);
      return claimId === undefined ? [] : [evidence.quoteOf.get(claimId) ?? ''];
    });
    const taken = new Set<StageFigureSlot>();
    const kept = written.filter((figure) => {
      const stated = !taken.has(figure.slot) && stageFigureIsStated(figure, quotes);
      if (stated) taken.add(figure.slot);
      else leftOut.push({ path: `items.${index}`, slot: figure.slot });
      return stated;
    });
    return kept.length === 0 ? rest : { ...rest, figures: kept };
  });
  return { authored: leftOut.length === 0 ? authored : { ...authored, items }, leftOut };
}

/**
 * What a recipe's stage plan asks of the finished document (D-382): that the picture stands on the orbit at enough different
 * months for the recap of the journey to draw (D-368), and that the first call shows the true picture to a reader who guessed
 * wrong. Findings are at the document's paths; the compile maps them to the writer's items.
 */
export function stagePlanIssues(document: ScrollDocumentV2, plan: StagePlanV2 | undefined): IssueV2[] {
  const stage = document.stage;
  if (plan === undefined || stage === undefined) return [];
  const issues: IssueV2[] = [];
  const months = stage.kit === EARTH_SKY_KIT ? recapMonths(stage.states.map((entry) => entry.state)) : [];
  if (plan.orbitMonths !== undefined && months.length < plan.orbitMonths)
    issues.push({ code: 'stage_months_too_few', path: 'stage.states' });
  if (plan.reveal === true) {
    const first = document.stops.findIndex((stop) => stop.kind === 'call_it');
    const call = document.stops[first];
    if (call?.kind === 'call_it' && call.revealStage === undefined)
      issues.push({ code: 'call_reveal_missing', path: `stops.${first}` });
  }
  return issues;
}
