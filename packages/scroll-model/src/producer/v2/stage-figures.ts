import type { ScrollDocumentV2 } from '../../v2/document.js';
import type { IssueV2 } from '../../v2/issues.js';
import { EARTH_SKY_KIT, recapMonths, type StageFigureSlot } from '../../v2/kit.js';
import type { AuthoringEvidence } from '../authoring-bind.js';
import { isFigure, type StagePlanV2 } from './assemble.js';
import type { AuthoredScrollV2, AuthoredStageFigure } from './authoring-schema.js';
import { numericTokens } from '../../text.js';
import { plainFigure, readingsOf, unitInPassages, type Reading } from './figures.js';

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

/**
 * Whether the cited passages state a figure of the stage as the figure is written (D-208, D-382): its digits with the word the
 * passage puts after them, standing beside the word that names its slot, in the unit and the place the passages use. A
 * figure the passages write another way (a range end, an exponent, a scaled `8.3m`), and a figure no passage holds, are not stated.
 */
export function stageFigureIsStated(figure: AuthoredStageFigure, quotes: readonly string[]): boolean {
  if (!isFigure(figure.value)) return false;
  const digits = plainFigure(String(figure.value).trim());
  const wanted: Reading = figure.magnitude ?? 'bare';
  const beside = quotes.some((quote) =>
    readingsOf(digits, [quote]).some(
      (way) =>
        way.reading === wanted &&
        way.otherEnd === undefined &&
        !way.negative &&
        slotNear(quote, way.index, FAMILY[figure.slot]) === figure.slot,
    ),
  );
  const daylight = figure.slot === 'june-daylight' || figure.slot === 'december-daylight';
  const placeStated = daylight ? figure.place !== undefined && unitInPassages(figure.place, quotes) : true;
  return beside && unitInPassages(figure.unit, quotes) && placeStated;
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
