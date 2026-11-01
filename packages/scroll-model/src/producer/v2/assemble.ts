import { INTEGRITY_METHOD, type Framing } from '../../document.js';
import {
  MAGNITUDES,
  type GuideCharacter,
  type Interactive,
  type InteractiveKind,
  type Magnitude,
  type SeriesPoint,
} from '../../v2/blocks.js';
import { truncateText } from '../../text.js';
import {
  SCROLL_DOCUMENT_V2_SCHEMA_VERSION,
  type Aside,
  type CallItStop,
  type FinalCallBinding,
  type FinalCallStop,
  type Landmark,
  type Misconception,
  type ReadStop,
  type Recap,
  type ScrollDocumentV2,
  type Stage,
  type Stop,
} from '../../v2/document.js';
import { EARTH_SKY_KIT } from '../../v2/kit.js';
import { applyKitPatch, kitDefinition, kitKeys, type StageKitId, type WordState } from '../../v2/kits/index.js';
import { FIELD_LIMITS_V2 as F, SCROLL_LIMITS_V2_VERSION } from '../../v2/limits.js';
import { computeMeasuresV2 } from '../../v2/measures.js';
import { computeIntegrityV2 } from '../../v2/validate.js';
import type { AuthoredItemV2, AuthoredScrollV2 } from './authoring-schema.js';

/** Who a Scroll is, as publication states it. Code chooses it (the recipe's), the writer never does. */
export interface PublicationV2 {
  readonly assetId: string;
  readonly revision: number;
  readonly language: string;
  readonly explanationUnitId: string;
  readonly kicker: string;
  readonly framing: Framing;
  readonly themeFamily: ScrollDocumentV2['theme']['family'];
}

/**
 * What the recipe decides before the writer starts: whether there is a stage, the misconception, the
 * landmark the Final call awards and the control it hands the reader. All of it is code-owned plan
 * data; the writer is told what the Final call is for, and writes none of it.
 */
export interface RecipeDataV2 {
  /** `stage` Scrolls carry the stage of their kit; `plain` Scrolls have no stage and still have calls. */
  readonly variant: 'stage' | 'plain';
  /** The kit a `stage` Scroll is drawn with (the recipe's `stageKit`). Absent: Earth & sky, the only kit before D-194. */
  readonly kit?: StageKitId;
  readonly misconception: Misconception;
  /** What a locked Final call awards. Absent: the Scroll awards nothing (D-188). */
  readonly landmark?: Landmark;
  /** The control the Final call hands the reader on the stage. Absent: the Final call is a plain call (D-187). */
  readonly finalCall?: FinalCallBinding;
  /** The play blocks this Scroll has, each used once. Absent or empty: none (D-207). Chosen by a person; the writer never adds one. */
  readonly blocks?: readonly InteractiveKind[];
  /** The character that speaks the Scroll's guide lines. Absent: no guide (D-207). */
  readonly guide?: GuideCharacter;
}

/** The kit a stage Scroll of this recipe is drawn with. */
export function recipeKit(recipe: Pick<RecipeDataV2, 'kit'>): StageKitId {
  return recipe.kit ?? EARTH_SKY_KIT;
}

/** Where each stop and aside of the document came from in the authored list, to report findings at the writer's item. */
export interface AssemblyMap {
  /** `stopItem[i]`: index in the authored list of the document's stop `i`. */
  readonly stopItem: readonly number[];
  readonly asideItem: readonly number[];
}

export type Assembly =
  | { readonly kind: 'assembled'; readonly document: ScrollDocumentV2; readonly map: AssemblyMap }
  | { readonly kind: 'unassemblable' };

/**
 * The place of the common guess among a call's authored options: the correct option is first, the
 * wrong option that states the myth is second. Position, not a number the writer must count (D-126).
 */
export const COMMON_GUESS_SLOT = 1;

/** One line of plain NFC text: runs of whitespace, line breaks included, become one space. */
const oneLine = (value: string): string => value.normalize('NFC').replace(/\s+/gu, ' ').trim();
const fit = (value: string, max: number): string => truncateText(oneLine(value), max);

/** FNV-1a: a small, stable string hash for seeding the option shuffle. */
function seedOf(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** mulberry32: a deterministic generator, so assembling the same authoring always gives the same document. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * The options in a stable pseudo-random order, with the index of the correct option (authored first)
 * and of the common guess in that order. The writer cannot learn that a position is the right one,
 * and the correct answer is not always first.
 */
export function shuffleOptions(
  options: readonly string[],
  commonGuess: number | undefined,
  seed: string,
): { readonly options: string[]; readonly answer: number; readonly commonGuess: number | undefined } {
  const order = options.map((_, index) => index);
  const random = generator(seedOf(seed));
  for (let at = order.length - 1; at > 0; at -= 1) {
    const other = Math.floor(random() * (at + 1));
    [order[at], order[other]] = [order[other] ?? 0, order[at] ?? 0];
  }
  return {
    options: order.map((index) => options[index] ?? ''),
    answer: order.indexOf(0),
    commonGuess: commonGuess === undefined ? undefined : order.indexOf(commonGuess),
  };
}

type Call = Extract<AuthoredItemV2, { type: 'call_it' | 'final_call' }>;

function callStop(
  item: Call,
  id: string,
  seed: string,
  recipe: RecipeDataV2,
  isFirstCall: boolean,
): CallItStop | FinalCallStop {
  // The reviewed source is the recipe's, never the model's: it only ever rides on the myth's own first call.
  const guessSource =
    item.type === 'call_it' && isFirstCall && recipe.misconception.kind === 'myth'
      ? recipe.misconception.source
      : undefined;
  const shuffled = shuffleOptions(
    item.options.map(oneLine),
    guessSource === undefined ? undefined : COMMON_GUESS_SLOT,
    seed,
  );
  const shared = {
    id,
    prompt: oneLine(item.prompt),
    options: shuffled.options,
    answer: shuffled.answer,
    explain: oneLine(item.explain),
    twist: oneLine(item.twist),
    simple: oneLine(item.simple),
  };
  if (item.type === 'final_call')
    return { kind: 'final_call', ...shared, ...(recipe.finalCall === undefined ? {} : { binding: recipe.finalCall }) };
  const guess =
    guessSource !== undefined && shuffled.commonGuess !== undefined
      ? { commonGuess: { option: shuffled.commonGuess, source: guessSource } }
      : {};
  return { kind: 'call_it', ...shared, ...guess };
}

/** A stable pseudo-random permutation of `count` places that is never the identity, so a sort is always a task. */
export function shuffledPlaces(count: number, seed: string): number[] {
  const places = Array.from({ length: count }, (_, index) => index);
  const random = generator(seedOf(seed));
  for (let at = count - 1; at > 0; at -= 1) {
    const other = Math.floor(random() * (at + 1));
    [places[at], places[other]] = [places[other] ?? 0, places[at] ?? 0];
  }
  return places.every((place, index) => place === index) ? places.map((_, index) => (index + 1) % count) : places;
}

/** The number a figure stands for: `4,096` is 4096. A text that is not a figure is 0, and the authoring rules refuse it. */
export function figureValue(figure: string | number): number {
  const value = typeof figure === 'number' ? figure : Number(figure.trim().replaceAll(',', ''));
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Whether a figure is written the way a passage writes one: digits, optional thousands commas, optional decimals. */
export const isFigure = (figure: string | number): boolean =>
  typeof figure === 'number' ? isFigure(String(figure)) : /^\d+(?:,\d{3})*(?:\.\d+)?$/u.test(figure.trim());

/** A figure and the word after it as one number: "8.3" and "million" are 8,300,000 (kept free of floating-point dust). */
export const valueOf = (figure: string | number, magnitude: Magnitude | undefined): number =>
  Number((figureValue(figure) * (magnitude === undefined ? 1 : MAGNITUDES[magnitude])).toPrecision(12));

const pointsOf = (
  points: readonly { label: string; value: string | number; magnitude?: Magnitude | undefined }[],
  maxChars: number,
): SeriesPoint[] =>
  points.map((point) => ({ label: fit(point.label, maxChars), value: valueOf(point.value, point.magnitude) }));

type PlayItem = Extract<AuthoredItemV2, { type: 'sort' | 'fork' | 'scale' | 'chart' }>;

/** The block a play item carries. Its text is the writer's, its order and its geometry are code's. */
function interactiveOf(item: PlayItem, seed: string): Interactive {
  switch (item.type) {
    case 'sort': {
      // The writer lists the items in the right order; the reader sees them shuffled, and the answer is the order.
      const shown = shuffledPlaces(item.items.length, seed);
      return {
        type: 'sort',
        items: shown.map((index) => fit(item.items[index] ?? '', F.sortItemChars)),
        order: item.items.map((_, place) => shown.indexOf(place)),
        explain: oneLine(item.explain),
      };
    }
    case 'fork':
      return {
        type: 'fork',
        prompt: oneLine(item.prompt),
        branches: item.branches.map((branch) => ({
          label: fit(branch.label, F.branchLabelChars),
          text: oneLine(branch.text),
        })),
      };
    case 'scale': {
      const points = pointsOf(item.points, F.pointLabelChars).sort((first, second) => first.value - second.value);
      const here =
        item.here === undefined
          ? -1
          : points.findIndex((point) => point.label === fit(item.here ?? '', F.pointLabelChars));
      return {
        type: 'scale',
        axis: item.axis,
        unit: fit(item.unit, F.unitChars),
        points,
        ...(here < 0 ? {} : { here }),
      };
    }
    case 'chart':
      return {
        type: 'chart',
        shape: item.shape,
        unit: fit(item.unit, F.unitChars),
        points: pointsOf(item.points, F.pointLabelChars),
      };
  }
}

function readStop(
  item: Extract<AuthoredItemV2, { type: 'stop' | 'sort' | 'fork' | 'scale' | 'chart' }>,
  id: string,
  seed: string,
  recipe: RecipeDataV2,
): ReadStop {
  return {
    kind: 'read',
    id,
    blocks: [
      ...(item.heading === undefined
        ? []
        : [{ type: 'heading' as const, level: 2 as const, text: fit(item.heading, F.headingChars) }]),
      { type: 'paragraph' as const, text: oneLine(item.text) },
      ...(item.line === undefined ? [] : [{ type: 'line' as const, text: oneLine(item.line) }]),
    ],
    ...(item.emphasis === undefined ? {} : { emphasis: item.emphasis }),
    simple: oneLine(item.simple),
    ...(item.type === 'stop' ? {} : { interactive: interactiveOf(item, `${seed}:${item.type}`) }),
    // The character is the recipe's: an item that asks for a guide where the recipe has none keeps no guide, and the rules report it.
    ...(item.type !== 'stop' || item.guide === undefined || recipe.guide === undefined
      ? {}
      : { guide: { character: recipe.guide, pose: item.guide.pose, line: oneLine(item.guide.line) } }),
  };
}

/**
 * The stage: a state for the first stop and for every stop after which the picture really differs.
 * What the writer chose carries over from stop to stop; what is stored is only what the view can
 * show (the kit's `settle`), so a choice that changes nothing visible records nothing, and everything
 * physical follows from the words by the kit's own code (D-124, D-195).
 */
function buildStage(
  kitId: StageKitId,
  stops: readonly Stop[],
  patches: readonly (Readonly<Record<string, string>> | undefined)[],
): Stage {
  const kit = kitDefinition(kitId);
  const same = (first: WordState, second: WordState): boolean =>
    kitKeys(kit).every((key) => first[key] === second[key]);
  const states: { stop: string; state: WordState; alt: string }[] = [];
  let chosen = kit.initial;
  let shown: WordState | undefined;
  stops.forEach((stop, index) => {
    chosen = applyKitPatch(kit, chosen, patches[index]);
    const settled = kit.settle(chosen);
    if (shown !== undefined && same(shown, settled)) return;
    shown = settled;
    states.push({ stop: stop.id, state: settled, alt: kit.describe(settled) });
  });
  // The kit's own functions made every state, so each holds exactly its words: the document validator proves it again.
  return { kit: kitId, states } as Stage;
}

/**
 * Turns the authored list into the canonical document. Deterministic and total: the same authoring,
 * publication and recipe always give the same document. It does not judge the result; the document
 * validator and the authoring rules do. Code sets every id (`s1`, `a1`), the stage's descriptions,
 * the order of the options, the misconception and its source, the measures and the hash.
 */
export function assembleScrollV2(
  authored: AuthoredScrollV2,
  publication: PublicationV2,
  recipe: RecipeDataV2,
): Assembly {
  const stops: Stop[] = [];
  const asides: Aside[] = [];
  const patches: (Readonly<Record<string, string>> | undefined)[] = [];
  const stopItem: number[] = [];
  const asideItem: number[] = [];
  let firstCall = true;
  authored.items.forEach((item, index) => {
    if (item.type === 'aside') {
      const anchor = stops.at(-1);
      // An aside before any stop has nothing to open next to: the authoring rules report it.
      if (anchor === undefined) return;
      asides.push({
        id: `a${asides.length + 1}`,
        kind: item.kind,
        title: fit(item.title, F.asideTitleChars),
        text: oneLine(item.text),
        anchorStop: anchor.id,
        collapsed: item.collapsed ?? item.kind === 'tangent',
      });
      asideItem.push(index);
      return;
    }
    const id = `s${stops.length + 1}`;
    const seed = `${publication.assetId}:${publication.revision}:${id}`;
    if (item.type !== 'call_it' && item.type !== 'final_call') stops.push(readStop(item, id, seed, recipe));
    else {
      stops.push(callStop(item, id, seed, recipe, firstCall && item.type === 'call_it'));
      if (item.type === 'call_it') firstCall = false;
    }
    patches.push(item.stage);
    stopItem.push(index);
  });
  if (stops.length === 0) return { kind: 'unassemblable' };
  const limitsAside = asides.find((aside) => aside.kind === 'limits');
  const recap: Recap = {
    captions: authored.recap.captions.map(oneLine),
    ...(limitsAside === undefined ? {} : { smallPrintAside: limitsAside.id }),
  };
  const unsigned = {
    schemaVersion: SCROLL_DOCUMENT_V2_SCHEMA_VERSION,
    assetId: publication.assetId,
    revision: publication.revision,
    language: publication.language,
    explanationUnitId: publication.explanationUnitId,
    theme: { family: publication.themeFamily },
    kicker: publication.kicker,
    title: fit(authored.title, 90),
    dek: fit(authored.dek, 200),
    framing: publication.framing,
    misconception: recipe.misconception,
    ...(recipe.landmark === undefined ? {} : { landmark: recipe.landmark }),
    ...(recipe.variant === 'stage' ? { stage: buildStage(recipeKit(recipe), stops, patches) } : {}),
    stops,
    asides,
    recap,
    askSuggestions: authored.askSuggestions.map(oneLine),
    limitsVersion: SCROLL_LIMITS_V2_VERSION,
    measures: computeMeasuresV2({ stops, asides, recap }),
  } as const;
  const document = {
    ...unsigned,
    integrity: { method: INTEGRITY_METHOD, sha256: computeIntegrityV2(unsigned) },
  } as ScrollDocumentV2;
  return { kind: 'assembled', document, map: { stopItem, asideItem } };
}
