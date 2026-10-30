import { INTEGRITY_METHOD, type Framing } from '../../document.js';
import { truncateText } from '../../text.js';
import {
  SCROLL_DOCUMENT_V2_SCHEMA_VERSION,
  type Aside,
  type CallItStop,
  type FinalCallStop,
  type Misconception,
  type ReadStop,
  type Recap,
  type ScrollDocumentV2,
  type Stage,
  type Stop,
} from '../../v2/document.js';
import { applyStagePatch, changesStage, describeStageState, EARTH_SKY_KIT, INITIAL_STAGE_STATE, type StagePatch } from '../../v2/kit.js';
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

/** What the recipe decides before the writer starts: whether there is a stage, and the misconception. */
export interface RecipeDataV2 {
  /** `stage` Scrolls carry the Earth & sky kit's stage; `plain` Scrolls have no stage and still have calls. */
  readonly variant: 'stage' | 'plain';
  readonly misconception: Misconception;
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
  const shuffled = shuffleOptions(item.options.map(oneLine), item.type === 'call_it' ? item.commonGuess : undefined, seed);
  const shared = {
    id,
    prompt: oneLine(item.prompt),
    options: shuffled.options,
    answer: shuffled.answer,
    explain: oneLine(item.explain),
    twist: oneLine(item.twist),
    simple: oneLine(item.simple),
  };
  if (item.type === 'final_call') return { kind: 'final_call', ...shared };
  const source = recipe.misconception.kind === 'myth' ? recipe.misconception.source : undefined;
  // The reviewed source is the recipe's, never the model's: it only ever rides on the myth's own first call.
  const guess =
    isFirstCall && source !== undefined && shuffled.commonGuess !== undefined && shuffled.commonGuess >= 0
      ? { commonGuess: { option: shuffled.commonGuess, source } }
      : {};
  return { kind: 'call_it', ...shared, ...guess };
}

function readStop(item: Extract<AuthoredItemV2, { type: 'stop' }>, id: string): ReadStop {
  return {
    kind: 'read',
    id,
    blocks: [
      ...(item.heading === undefined ? [] : [{ type: 'heading' as const, level: 2 as const, text: fit(item.heading, F.headingChars) }]),
      { type: 'paragraph' as const, text: oneLine(item.text) },
      ...(item.line === undefined ? [] : [{ type: 'line' as const, text: oneLine(item.line) }]),
    ],
    ...(item.emphasis === undefined ? {} : { emphasis: item.emphasis }),
    simple: oneLine(item.simple),
  };
}

/** The stage: a state for the first stop and for every stop whose patch changes something. */
function buildStage(stops: readonly Stop[], patches: readonly (StagePatch | undefined)[]): Stage {
  const states: Stage['states'] = [];
  let state = INITIAL_STAGE_STATE;
  stops.forEach((stop, index) => {
    const patch = patches[index];
    if (index > 0 && !changesStage(state, patch)) return;
    state = applyStagePatch(state, patch);
    states.push({ stop: stop.id, state, alt: describeStageState(state) });
  });
  return { kit: EARTH_SKY_KIT, states };
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
  const patches: (StagePatch | undefined)[] = [];
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
    if (item.type === 'stop') stops.push(readStop(item, id));
    else {
      stops.push(callStop(item, id, `${publication.assetId}:${publication.revision}:${id}`, recipe, firstCall && item.type === 'call_it'));
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
    ...(recipe.variant === 'stage' ? { stage: buildStage(stops, patches) } : {}),
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
