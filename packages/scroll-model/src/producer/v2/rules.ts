import { numericTokens, copiedRuns } from '../../text.js';
import { uniqueIssuesV2, type IssueV2 } from '../../v2/issues.js';
import type { AuthoringEvidence } from '../authoring-bind.js';
import { COPY_RUN_WORDS } from '../compile.js';
import type { AuthoredItemV2, AuthoredScrollV2 } from './authoring-schema.js';
import type { RecipeDataV2 } from './assemble.js';

/** What the authoring rules need besides the authored list. */
export interface AuthoringRulesInput {
  readonly recipe: RecipeDataV2;
  readonly evidence: AuthoringEvidence;
  /** All research text the copy check compares against: the offered passages and the pages they came from. */
  readonly sources: readonly string[];
}

/** The number as written, without thousands separators: `4,096` and `4096` are one figure. */
const figure = (token: string): string => token.replaceAll(',', '');

function figuresIn(text: string): Set<string> {
  return new Set(numericTokens(text).map(([start, end]) => figure(text.slice(start, end))));
}

/** The reader-facing strings of an item, in reading order. Citations are handles, not reader text. */
function readerTexts(item: AuthoredItemV2): string[] {
  switch (item.type) {
    case 'stop':
      return [item.heading, item.text, item.line, item.simple].filter((text): text is string => text !== undefined);
    case 'call_it':
    case 'final_call':
      return [item.prompt, ...item.options, item.explain, item.twist, item.simple];
    case 'aside':
      return [item.title, item.text];
  }
}

/** Where the writer put things that code cannot place: asides before a stop or after the end. */
function placementIssues(authored: AuthoredScrollV2): IssueV2[] {
  const issues: IssueV2[] = [];
  let seenStop = false;
  let seenFinal = false;
  authored.items.forEach((item, index) => {
    const path = `items.${index}`;
    if (item.type === 'aside') {
      if (!seenStop) issues.push({ code: 'aside_before_stop', path });
      else if (seenFinal)
        issues.push({ code: item.kind === 'limits' ? 'limits_aside_last' : 'aside_after_final_call', path });
      return;
    }
    seenStop = true;
    if (item.type === 'final_call') seenFinal = true;
  });
  return issues;
}

/** A plain Scroll has no stage; a stage Scroll sets the starting picture on its first stop. */
function stageIssues(authored: AuthoredScrollV2, recipe: RecipeDataV2): IssueV2[] {
  const issues: IssueV2[] = [];
  const first = authored.items.findIndex((item) => item.type !== 'aside');
  authored.items.forEach((item, index) => {
    if (item.type !== 'aside' && item.stage !== undefined && recipe.variant === 'plain')
      issues.push({ code: 'stage_unexpected', path: `items.${index}.stage` });
  });
  const opening = authored.items[first];
  if (
    recipe.variant === 'stage' &&
    opening !== undefined &&
    opening.type !== 'aside' &&
    opening.stage?.view === undefined
  )
    issues.push({ code: 'stage_first_state_missing', path: `items.${first}.stage` });
  return issues;
}

interface Unit {
  readonly path: string;
  readonly texts: readonly string[];
  /** The handles this unit cites, or `undefined` when it may rest on any passage the Scroll cites. */
  readonly cites: readonly string[] | undefined;
}

function unitsOf(authored: AuthoredScrollV2): Unit[] {
  return [
    { path: 'title', texts: [authored.title], cites: undefined },
    { path: 'dek', texts: [authored.dek], cites: undefined },
    ...authored.items.map((item, index): Unit => ({
      path: `items.${index}`,
      texts: readerTexts(item),
      cites: item.cites,
    })),
    { path: 'recap', texts: authored.recap.captions, cites: authored.recap.cites },
    { path: 'askSuggestions', texts: authored.askSuggestions, cites: undefined },
  ];
}

/**
 * Earth's axis is tilted by a fixed angle; "sideways" and "on its side" are the words for Uranus. A
 * sentence of a stage Scroll (whose picture is always Earth) that joins them to the axis, the lean
 * or the tilt is refused, because it teaches a picture the kit never draws (D-123). A plain Scroll
 * may say them: its subject may be Uranus.
 */
const SIDEWAYS = /\bsideways\b|\bon (?:its|their) side\b/iu;
const AXIS_WORDS = /\b(?:axis|axes|lean|leans|leaning|tilt|tilts|tilted|tilting)\b/iu;

function earthAxisIssues(authored: AuthoredScrollV2, recipe: RecipeDataV2): IssueV2[] {
  if (recipe.variant !== 'stage') return [];
  const sidewaysAxis = (text: string): boolean =>
    text.split(/(?<=[.!?])\s+/u).some((sentence) => SIDEWAYS.test(sentence) && AXIS_WORDS.test(sentence));
  return unitsOf(authored)
    .filter((unit) => unit.texts.some(sidewaysAxis))
    .map((unit): IssueV2 => ({ code: 'earth_axis_sideways', path: unit.path }));
}

/**
 * Every claim in a call's answer, an aside or a stop cites a passage, like any other claim: handles
 * must exist, at least `minDistinctCitations` different passages are cited in all, and every figure
 * in reader text appears in a passage its unit cites. Kit values are words, never numbers, so there
 * is nothing else to bind.
 */
function citationIssues(authored: AuthoredScrollV2, evidence: AuthoringEvidence): IssueV2[] {
  const issues: IssueV2[] = [];
  const figuresByClaim = new Map<string, Set<string>>();
  const figuresOf = (claimId: string): Set<string> => {
    let known = figuresByClaim.get(claimId);
    if (known === undefined) {
      known = figuresIn(evidence.quoteOf.get(claimId) ?? '');
      figuresByClaim.set(claimId, known);
    }
    return known;
  };
  const claimsOf = (handles: readonly string[]): string[] =>
    handles.flatMap((handle) => {
      const claimId = evidence.claimIdOf.get(handle);
      return claimId === undefined ? [] : [claimId];
    });
  const units = unitsOf(authored);
  const everything = new Set(units.flatMap((unit) => claimsOf(unit.cites ?? [])));
  for (const unit of units) {
    for (const handle of unit.cites ?? [])
      if (!evidence.claimIdOf.has(handle)) issues.push({ code: 'authoring_cite_unknown', path: unit.path });
    const candidates = unit.cites === undefined ? [...everything] : claimsOf(unit.cites);
    const unsupported = unit.texts.some((text) =>
      numericTokens(text).some(
        ([start, end]) => !candidates.some((claimId) => figuresOf(claimId).has(figure(text.slice(start, end)))),
      ),
    );
    if (unsupported) issues.push({ code: 'authoring_number_not_in_evidence', path: unit.path });
  }
  if (everything.size < evidence.minDistinctCitations) issues.push({ code: 'authoring_too_few_cites', path: '$' });
  return issues;
}

/** No run of nine words in a row may match the research, in any reader text. */
function copyIssues(authored: AuthoredScrollV2, sources: readonly string[]): IssueV2[] {
  return unitsOf(authored)
    .filter((unit) => unit.texts.some((text) => copiedRuns(text, sources, COPY_RUN_WORDS).length > 0))
    .map((unit): IssueV2 => ({ code: 'copied_passage', path: unit.path }));
}

/**
 * The checks only the authored list can make, because the assembled document no longer says what
 * the writer wrote where: placement of asides, the stage against the recipe's variant (and what a stage
 * Scroll may say about Earth's axis), citations and figures, and copying. Everything the document itself can prove (word limits, the call budget, the
 * Final call and whether it restates a call, the limits aside, the stage's order and what it holds,
 * the reading time) is left to `validateDocumentV2`. The common guess has no check here: it is a
 * place in the call's options that code reads (D-126), not a number the writer could get wrong.
 *
 * Pure and deterministic. Findings are located at the writer's item (`items.4`, `recap`) and carry
 * no text.
 */
export function authoringIssuesV2(authored: AuthoredScrollV2, input: AuthoringRulesInput): IssueV2[] {
  return uniqueIssuesV2([
    ...placementIssues(authored),
    ...stageIssues(authored, input.recipe),
    ...earthAxisIssues(authored, input.recipe),
    ...citationIssues(authored, input.evidence),
    ...copyIssues(authored, input.sources),
  ]);
}
