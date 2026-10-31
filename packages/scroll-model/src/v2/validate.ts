import { canonicalJson, canonicalSha256, canonicalSize } from '../canonical.js';
import { INTEGRITY_METHOD } from '../document.js';
import { issueFromSchema } from '../issues.js';
import { countWords } from '../text.js';
import { type Interactive, type ScaleBlock, type SortBlock } from './blocks.js';
import { callsOf, ScrollDocumentV2, type CallItStop, type FinalCallStop, type Stop } from './document.js';
import { uniqueIssuesV2, type IssueV2 } from './issues.js';
import { EARTH_SKY_KIT, tiltMatters } from './kit.js';
import { kitDefinition } from './kits/index.js';
import { LIMITS_V2 } from './limits.js';
import { computeMeasuresV2, READING_SECONDS_V2 } from './measures.js';
import { restates } from './similarity.js';

/** SHA-256 of the canonical JSON of the document without its `integrity` member. */
export function computeIntegrityV2(document: Omit<ScrollDocumentV2, 'integrity'> & { integrity?: unknown }): string {
  return canonicalSha256({ ...document, integrity: undefined });
}

export interface ValidateV2Options {
  /**
   * Recompute the reading measures, the reading time and the integrity hash (the default). Only
   * `parseDocumentV2`, the client path, turns it off, as v1's `parseDocument` does: SHA-256 over up
   * to 128 KiB is cheap on a JIT and not on Hermes.
   */
  readonly verify?: boolean;
}

export type DocumentV2Outcome =
  | {
      readonly kind: 'valid';
      readonly document: ScrollDocumentV2;
      /** Things a person must still settle before the Scroll joins the library; they do not refuse the document. */
      readonly notices: readonly IssueV2[];
    }
  | { readonly kind: 'invalid'; readonly issues: readonly IssueV2[] };

const idPaths = (document: ScrollDocumentV2): [string, string][] => [
  ...document.stops.map((stop, index): [string, string] => [stop.id, `stops.${index}.id`]),
  ...document.asides.map((aside, index): [string, string] => [aside.id, `asides.${index}.id`]),
];

function idIssues(document: ScrollDocumentV2): IssueV2[] {
  const seen = new Set<string>();
  const issues: IssueV2[] = [];
  for (const [id, path] of idPaths(document)) {
    if (seen.has(id)) issues.push({ code: 'id_duplicate', path });
    seen.add(id);
  }
  return issues;
}

function stopTextIssues(stop: Stop, index: number): IssueV2[] {
  const path = `stops.${index}`;
  const issues: IssueV2[] = [];
  if (countWords(stop.simple) > LIMITS_V2.stopWords) issues.push({ code: 'simple_too_long', path: `${path}.simple` });
  if (stop.kind !== 'read') {
    for (const field of ['explain', 'twist'] as const)
      if (countWords(stop[field]) > LIMITS_V2.stopWords)
        issues.push({ code: 'stop_too_long', path: `${path}.${field}` });
    return issues;
  }
  let spoken = 0;
  stop.blocks.forEach((block, blockIndex) => {
    if (block.type === 'heading') {
      if (blockIndex !== 0) issues.push({ code: 'heading_misplaced', path: `${path}.blocks.${blockIndex}` });
      return;
    }
    spoken += countWords(block.text);
    if (block.type === 'line' && countWords(block.text) > LIMITS_V2.lineWords)
      issues.push({ code: 'line_too_long', path: `${path}.blocks.${blockIndex}` });
  });
  if (spoken > LIMITS_V2.stopWords) issues.push({ code: 'stop_too_long', path });
  return issues;
}

const distinct = (texts: readonly string[]): boolean =>
  new Set(texts.map((text) => text.trim().toLowerCase())).size === texts.length;

function sortIssues(sort: SortBlock, path: string): IssueV2[] {
  const issues: IssueV2[] = [];
  const isPermutation =
    sort.order.length === sort.items.length &&
    new Set(sort.order).size === sort.order.length &&
    sort.order.every((index) => index < sort.items.length);
  if (!isPermutation) issues.push({ code: 'sort_order_invalid', path: `${path}.order` });
  // A sort whose items are already shown in the right order asks nothing of the reader.
  else if (sort.order.every((index, place) => index === place))
    issues.push({ code: 'sort_already_ordered', path: `${path}.items` });
  if (!distinct(sort.items)) issues.push({ code: 'sort_items_duplicate', path: `${path}.items` });
  if (countWords(sort.explain) > LIMITS_V2.stopWords) issues.push({ code: 'stop_too_long', path: `${path}.explain` });
  return issues;
}

function scaleIssues(scale: ScaleBlock, path: string): IssueV2[] {
  const issues: IssueV2[] = [];
  const values = scale.points.map((point) => point.value);
  // Rising and strictly so: two points at one value are one point, and a log axis has no zero.
  const rising = values.every((value, index) => index === 0 || value > (values[index - 1] ?? Infinity));
  if (!rising || (scale.axis === 'log' && values.some((value) => value <= 0)))
    issues.push({ code: 'scale_values_invalid', path: `${path}.points` });
  if (!distinct(scale.points.map((point) => point.label)))
    issues.push({ code: 'chart_labels_duplicate', path: `${path}.points` });
  if (scale.here !== undefined && scale.here >= scale.points.length)
    issues.push({ code: 'scale_here_invalid', path: `${path}.here` });
  return issues;
}

function interactiveIssues(interactive: Interactive, path: string): IssueV2[] {
  switch (interactive.type) {
    case 'sort':
      return sortIssues(interactive, path);
    case 'scale':
      return scaleIssues(interactive, path);
    case 'chart':
      return distinct(interactive.points.map((point) => point.label))
        ? []
        : [{ code: 'chart_labels_duplicate', path: `${path}.points` }];
    case 'fork': {
      const issues: IssueV2[] = [];
      if (!distinct(interactive.branches.map((branch) => branch.label)))
        issues.push({ code: 'fork_branches_duplicate', path: `${path}.branches` });
      interactive.branches.forEach((branch, index) => {
        if (countWords(branch.text) > LIMITS_V2.branchWords)
          issues.push({ code: 'fork_branch_too_long', path: `${path}.branches.${index}` });
      });
      return issues;
    }
  }
}

/**
 * The play blocks and the guide of the read stops (D-207): at most two interactives and two guide
 * lines, a guide that speaks rarely (two stops at least between lines) and in few words, and each block's
 * own structure: a sort that has an order to find, a scale that rises, a fork whose branches differ.
 * Only data is checked here; that a chart's figures come from the cited passages is the authoring rules'.
 */
/** A guide speaks rarely: two stops at least between one line and the next (D-207). */
const GUIDE_GAP = 3;

function blockIssues(document: ScrollDocumentV2): IssueV2[] {
  const issues: IssueV2[] = [];
  let interactives = 0;
  let guides = 0;
  let lastGuide = -GUIDE_GAP;
  document.stops.forEach((stop, index) => {
    if (stop.kind !== 'read') return;
    const path = `stops.${index}`;
    if (stop.interactive !== undefined) {
      interactives += 1;
      if (interactives === LIMITS_V2.otherInteractives + 1)
        issues.push({ code: 'interactive_budget_exceeded', path: `${path}.interactive` });
      issues.push(...interactiveIssues(stop.interactive, `${path}.interactive`));
    }
    if (stop.guide === undefined) return;
    guides += 1;
    if (guides === LIMITS_V2.guides + 1) issues.push({ code: 'guide_budget_exceeded', path: `${path}.guide` });
    if (index < lastGuide + GUIDE_GAP) issues.push({ code: 'guide_too_close', path: `${path}.guide` });
    lastGuide = index;
    if (countWords(stop.guide.line) > LIMITS_V2.guideWords)
      issues.push({ code: 'guide_too_long', path: `${path}.guide.line` });
  });
  return issues;
}

/** Calls: the budget, the Final call at the end, answers inside their options, the common guess. */
function callIssues(document: ScrollDocumentV2): IssueV2[] {
  const issues: IssueV2[] = [];
  const calls = callsOf(document);
  if (calls.length > LIMITS_V2.calls) issues.push({ code: 'call_budget_exceeded', path: 'stops' });
  const finals = document.stops.filter((stop) => stop.kind === 'final_call');
  if (finals.length === 0) issues.push({ code: 'final_call_missing', path: 'stops' });
  if (finals.length > 1 || (finals.length === 1 && document.stops.at(-1)?.kind !== 'final_call'))
    issues.push({ code: 'final_call_misplaced', path: 'stops' });
  if (!document.stops.some((stop) => stop.kind === 'call_it')) issues.push({ code: 'call_it_missing', path: 'stops' });
  let firstCallIt = true;
  document.stops.forEach((stop, index) => {
    if (stop.kind === 'read') return;
    const path = `stops.${index}`;
    if (stop.answer >= stop.options.length) issues.push({ code: 'call_answer_invalid', path: `${path}.answer` });
    const lowered = stop.options.map((option) => option.trim().toLowerCase());
    if (new Set(lowered).size !== lowered.length)
      issues.push({ code: 'call_options_duplicate', path: `${path}.options` });
    if (stop.kind === 'final_call') return;
    const guess = stop.commonGuess;
    // Only the first Call it of a myth Scroll carries the common guess: it is the misconception's own question.
    const expected = document.misconception.kind === 'myth' && firstCallIt;
    firstCallIt = false;
    if (guess === undefined) {
      if (expected) issues.push({ code: 'common_guess_missing', path });
      return;
    }
    if (!expected) issues.push({ code: 'common_guess_unexpected', path: `${path}.commonGuess` });
    else if (
      guess.option >= stop.options.length ||
      guess.option === stop.answer ||
      canonicalJson(guess.source) !==
        canonicalJson(document.misconception.kind === 'myth' ? document.misconception.source : null)
    )
      issues.push({ code: 'common_guess_invalid', path: `${path}.commonGuess` });
  });
  return issues;
}

/**
 * The Final call applies the idea to a new case. One whose question, or whose correct answer, is
 * near-identical to an earlier call's only asks again, so it is refused (D-126).
 */
function restatementIssues(document: ScrollDocumentV2): IssueV2[] {
  const finalIndex = document.stops.findIndex((stop) => stop.kind === 'final_call');
  const final = document.stops[finalIndex];
  if (final === undefined || final.kind !== 'final_call') return [];
  const correct = (stop: CallItStop | FinalCallStop): string => stop.options[stop.answer] ?? '';
  const asksAgain = document.stops
    .slice(0, finalIndex)
    .some(
      (stop) =>
        stop.kind !== 'read' && (restates(stop.prompt, final.prompt) || restates(correct(stop), correct(final))),
    );
  return asksAgain ? [{ code: 'final_call_restates_call', path: `stops.${finalIndex}` }] : [];
}

/**
 * A Final call's binding hands the reader a control on the stage (D-187): the Scroll needs a stage,
 * and the picture held at the Final call must change when the control is turned. So it is not the
 * Moon view (no axis) and not an equinox (March or September: the Sun is over the equator at every
 * tilt, so the picture is the same wherever the slider is), see `tiltMatters`.
 */
function bindingIssues(document: ScrollDocumentV2): IssueV2[] {
  const finalIndex = document.stops.findIndex((stop) => stop.kind === 'final_call');
  const final = document.stops[finalIndex];
  if (final?.kind !== 'final_call' || final.binding === undefined) return [];
  const invalid: IssueV2[] = [{ code: 'final_call_binding_invalid', path: `stops.${finalIndex}.binding` }];
  const stopIndex = new Map(document.stops.map((stop, index) => [stop.id, index]));
  const stage = document.stage;
  // Only the Earth & sky kit draws an axis to turn; a stage of any other kit cannot honour a tilt.
  const held =
    stage?.kit === EARTH_SKY_KIT
      ? stage.states.filter((entry) => (stopIndex.get(entry.stop) ?? Infinity) <= finalIndex).at(-1)
      : undefined;
  return held !== undefined && tiltMatters(held.state) ? [] : invalid;
}

/** Asides: each opens next to a stop; a limits aside exists, opens before the Final call, and the recap links to it. */
function asideIssues(document: ScrollDocumentV2): IssueV2[] {
  const issues: IssueV2[] = [];
  const stopIndex = new Map(document.stops.map((stop, index) => [stop.id, index]));
  document.asides.forEach((aside, index) => {
    if (!stopIndex.has(aside.anchorStop))
      issues.push({ code: 'aside_anchor_unknown', path: `asides.${index}.anchorStop` });
    if (countWords(aside.text) > LIMITS_V2.stopWords)
      issues.push({ code: 'stop_too_long', path: `asides.${index}.text` });
  });
  const limits = document.asides.filter((aside) => aside.kind === 'limits');
  if (limits.length === 0) issues.push({ code: 'limits_aside_missing', path: 'asides' });
  const finalIndex = document.stops.findIndex((stop) => stop.kind === 'final_call');
  const lastReadable = finalIndex >= 0 ? finalIndex : document.stops.length - 1;
  limits.forEach((aside) => {
    const anchor = stopIndex.get(aside.anchorStop);
    if (anchor !== undefined && anchor >= lastReadable)
      issues.push({ code: 'limits_aside_last', path: `asides.${document.asides.indexOf(aside)}.anchorStop` });
  });
  const linked = document.recap.smallPrintAside;
  if (limits.length > 0 && !limits.some((aside) => aside.id === linked))
    issues.push({ code: 'recap_small_print_unknown', path: 'recap.smallPrintAside' });
  return issues;
}

/**
 * The stage: states in stop order from the first stop, each describing itself, enough of them to be
 * a stage. A state sits on a read stop, never on a call, so the picture cannot show an answer before
 * the reader has given one (D-124). Each state holds only what its view draws, and its physics (tilt,
 * pins, Ray) follows from the month, so there is nothing else to contradict.
 */
function stageIssues(document: ScrollDocumentV2): IssueV2[] {
  const stage = document.stage;
  if (stage === undefined) return [];
  const issues: IssueV2[] = [];
  const kit = kitDefinition(stage.kit);
  const stopIndex = new Map(document.stops.map((stop, index) => [stop.id, index]));
  let previousIndex = -1;
  stage.states.forEach((entry, index) => {
    const path = `stage.states.${index}`;
    const at = stopIndex.get(entry.stop);
    if (at === undefined) issues.push({ code: 'stage_state_stop_unknown', path: `${path}.stop` });
    else {
      if (at <= previousIndex) issues.push({ code: 'stage_states_unordered', path: `${path}.stop` });
      previousIndex = at;
    }
    if (at !== undefined && document.stops[at]?.kind !== 'read')
      issues.push({ code: 'stage_state_on_call', path: `${path}.stop` });
    if (canonicalJson(kit.settle(entry.state)) !== canonicalJson(entry.state))
      issues.push({ code: 'stage_state_unsettled', path: `${path}.state` });
    if (entry.alt !== kit.describe(entry.state)) issues.push({ code: 'stage_alt_mismatch', path: `${path}.alt` });
    const before = stage.states[index - 1];
    if (before !== undefined && canonicalJson(before.state) === canonicalJson(entry.state))
      issues.push({ code: 'stage_state_repeated', path });
  });
  if (stage.states[0]?.stop !== document.stops[0]?.id)
    issues.push({ code: 'stage_first_state_missing', path: 'stage.states' });
  if (stage.states.length < LIMITS_V2.minStageStates) issues.push({ code: 'stage_too_static', path: 'stage.states' });
  return issues;
}

/** Measures, reading time and the integrity hash: always recomputed from the document itself. */
function storedIssues(document: ScrollDocumentV2): IssueV2[] {
  const issues: IssueV2[] = [];
  const measures = computeMeasuresV2(document);
  if (canonicalJson(measures) !== canonicalJson(document.measures))
    issues.push({ code: 'measures_mismatch', path: 'measures' });
  if (measures.readingSeconds < READING_SECONDS_V2.min || measures.readingSeconds > READING_SECONDS_V2.max)
    issues.push({ code: 'reading_length_out_of_brief', path: 'measures.readingSeconds' });
  if (document.integrity.method !== INTEGRITY_METHOD || computeIntegrityV2(document) !== document.integrity.sha256)
    issues.push({ code: 'integrity_mismatch', path: 'integrity' });
  return issues;
}

/**
 * Admission of a `scroll-document.v2`: the size, the schema, the budget of `scroll-limits.v2`, the
 * structure rules (a Final call ends the spine, a limits aside is never last, calls answer inside
 * their options, the common guess is the recipe's) and the stored measures and hash, recomputed.
 *
 * Pure and deterministic; the findings carry codes and paths, never the text they are about. The
 * client path, `parseDocumentV2`, skips the measures and the hash exactly as v1's does.
 */
export function validateDocumentV2(input: unknown, options: ValidateV2Options = {}): DocumentV2Outcome {
  try {
    if (canonicalSize(input) > LIMITS_V2.documentBytes)
      return { kind: 'invalid', issues: [{ code: 'document_too_large', path: '$' }] };
  } catch {
    return { kind: 'invalid', issues: [{ code: 'document_not_object', path: '$' }] };
  }
  const parsed = ScrollDocumentV2.safeParse(input);
  if (!parsed.success) return { kind: 'invalid', issues: uniqueIssuesV2(parsed.error.issues.map(issueFromSchema)) };
  const document = parsed.data;
  const issues: IssueV2[] = [
    ...idIssues(document),
    ...(document.stops.length < LIMITS_V2.minStops ? [{ code: 'stops_too_few', path: 'stops' } as const] : []),
    ...(document.stops.filter((stop) => stop.kind === 'read').length < LIMITS_V2.minReadStops
      ? [{ code: 'read_stops_too_few', path: 'stops' } as const]
      : []),
    ...document.stops.flatMap(stopTextIssues),
    ...blockIssues(document),
    ...callIssues(document),
    ...restatementIssues(document),
    ...bindingIssues(document),
    ...asideIssues(document),
    ...stageIssues(document),
    ...(options.verify === false ? [] : storedIssues(document)),
  ];
  if (issues.length > 0) return { kind: 'invalid', issues: uniqueIssuesV2(issues) };
  const notices: IssueV2[] =
    document.misconception.kind === 'myth' && !document.misconception.source.reviewed
      ? [{ code: 'misconception_source_unreviewed', path: 'misconception.source' }]
      : [];
  return { kind: 'valid', document, notices };
}
