import { z } from 'zod';
import type { AnyBlock } from './blocks/catalog.js';
import { canonicalJson, canonicalSize } from './canonical.js';
import { findBlock, walkBlocks, type ScrollDocument } from './document.js';
import { LIMITS } from './limits.js';
import { BlockTypeName, BlockVersionNumber, LocalId, OpaqueId, Revision, Sha256Hex } from './primitives.js';
import { projectText } from './registry.js';
import { sha256Hex } from './sha256.js';
import { blockStateProblems, BlockStateSnapshot, defaultBlockState, personalParamKeys } from './state.js';
import { isGraphemeBoundary } from './text.js';

/**
 * Anchored references into a Scroll revision (blueprint §17 "Snippets are anchored references"):
 * a text passage of one block, or a whole block with an optional state snapshot. Both point at an
 * exact revision; a correction re-points them only through an explicit anchor map.
 */

/** A text range `[start, end)` in UTF-16 code units over the block's `text-projection.v1`. */
export const ScrollPassageLocator = z.strictObject({
  kind: z.literal('scroll_passage'),
  assetId: OpaqueId,
  revision: Revision,
  blockId: LocalId,
  start: z.number().int().min(0),
  end: z.number().int().min(1),
  /** SHA-256 of the quoted text (UTF-8), so a card proves what it quotes. */
  quoteHash: Sha256Hex,
});
export type ScrollPassageLocator = z.infer<typeof ScrollPassageLocator>;

export const ScrollBlockLocator = z.strictObject({
  kind: z.literal('scroll_block'),
  assetId: OpaqueId,
  revision: Revision,
  blockId: LocalId,
  blockType: BlockTypeName,
  blockVersion: BlockVersionNumber,
  state: BlockStateSnapshot.optional(),
});
export type ScrollBlockLocator = z.infer<typeof ScrollBlockLocator>;

export const ScrollLocator = z.discriminatedUnion('kind', [ScrollPassageLocator, ScrollBlockLocator]);
export type ScrollLocator = z.infer<typeof ScrollLocator>;

export function quoteHash(quote: string): string {
  return sha256Hex(quote);
}

export type LocatorRejection =
  | 'asset-mismatch'
  | 'revision-mismatch'
  | 'block-not-found'
  | 'block-not-text'
  | 'range-invalid'
  | 'range-too-long'
  | 'range-splits-character'
  | 'quote-hash-mismatch'
  | 'block-type-mismatch'
  | 'block-version-mismatch'
  | 'state-not-allowed'
  | 'state-invalid'
  | 'state-too-large'
  | 'personal-not-confirmed'
  | 'personal-flag-mismatch';

export type LocatorOutcome =
  | {
      readonly kind: 'valid';
      readonly sectionId: string;
      readonly sectionHeading: string | null;
      /** The quoted text of a passage, or null for a block locator. */
      readonly quote: string | null;
      readonly block: AnyBlock;
    }
  | { readonly kind: 'invalid'; readonly reason: LocatorRejection };

function rangeRejection(text: string, start: number, end: number): LocatorRejection | null {
  if (!(start < end) || end > text.length) return 'range-invalid';
  if (end - start > LIMITS.passageChars) return 'range-too-long';
  // A passage starts and ends between user-perceived characters (never inside "q̇", "👩‍💻" or a
  // surrogate pair): `Intl.Segmenter` where available, `grapheme-fallback.v1` otherwise.
  if (!isGraphemeBoundary(text, start) || !isGraphemeBoundary(text, end)) return 'range-splits-character';
  return null;
}

/** Builds the passage locator for a text selection, after checking it against the document. */
export function createPassageLocator(
  document: ScrollDocument,
  blockId: string,
  start: number,
  end: number,
):
  | { readonly kind: 'locator'; readonly locator: ScrollPassageLocator }
  | { readonly kind: 'invalid'; readonly reason: LocatorRejection } {
  const visit = findBlock(document, blockId);
  if (visit === null) return { kind: 'invalid', reason: 'block-not-found' };
  const text = projectText(visit.block);
  if (text === null) return { kind: 'invalid', reason: 'block-not-text' };
  const rejection = rangeRejection(text, start, end);
  if (rejection !== null) return { kind: 'invalid', reason: rejection };
  return {
    kind: 'locator',
    locator: {
      kind: 'scroll_passage',
      assetId: document.assetId,
      revision: document.revision,
      blockId,
      start,
      end,
      quoteHash: quoteHash(text.slice(start, end)),
    },
  };
}

/**
 * Validates a locator against the exact revision it names. A personal parameter value in a block
 * snapshot is accepted only when the snapshot says it was included and the sender confirmed it
 * (`personalConsent`, default false).
 */
export function validateLocator(
  document: ScrollDocument,
  locator: ScrollLocator,
  options: { personalConsent?: boolean } = {},
): LocatorOutcome {
  if (locator.assetId !== document.assetId) return { kind: 'invalid', reason: 'asset-mismatch' };
  if (locator.revision !== document.revision) return { kind: 'invalid', reason: 'revision-mismatch' };
  const visit = findBlock(document, locator.blockId);
  if (visit === null) return { kind: 'invalid', reason: 'block-not-found' };
  const { block, section } = visit;
  const valid = (quote: string | null): LocatorOutcome => ({
    kind: 'valid',
    sectionId: section.id,
    sectionHeading: section.heading,
    quote,
    block,
  });

  if (locator.kind === 'scroll_passage') {
    const text = projectText(block);
    if (text === null) return { kind: 'invalid', reason: 'block-not-text' };
    const rejection = rangeRejection(text, locator.start, locator.end);
    if (rejection !== null) return { kind: 'invalid', reason: rejection };
    const quote = text.slice(locator.start, locator.end);
    if (quoteHash(quote) !== locator.quoteHash) return { kind: 'invalid', reason: 'quote-hash-mismatch' };
    return valid(quote);
  }

  if (locator.blockType !== block.type) return { kind: 'invalid', reason: 'block-type-mismatch' };
  if (locator.blockVersion !== block.version) return { kind: 'invalid', reason: 'block-version-mismatch' };
  const snapshot = locator.state;
  if (snapshot === undefined) return valid(null);
  if (defaultBlockState(block) === null) return { kind: 'invalid', reason: 'state-not-allowed' };
  if (canonicalSize(snapshot) > LIMITS.blockStateBytes) return { kind: 'invalid', reason: 'state-too-large' };
  if (blockStateProblems(block, snapshot.state, { partial: true }).length > 0)
    return { kind: 'invalid', reason: 'state-invalid' };
  const params = snapshot.state.type === 'simulation' ? snapshot.state.params : {};
  const carriesPersonal = personalParamKeys(block).some((key) => Object.hasOwn(params, key));
  if (carriesPersonal !== snapshot.personalIncluded) return { kind: 'invalid', reason: 'personal-flag-mismatch' };
  if (carriesPersonal && options.personalConsent !== true) return { kind: 'invalid', reason: 'personal-not-confirmed' };
  return valid(null);
}

/** How a block of one revision relates to the next. */
export const ANCHOR_CHANGES = [
  /** Identical content. */
  'same',
  /** Content changed in ways that keep text offsets and state valid (a caption, a label). */
  'updated',
  /** The projected text changed: passages re-anchor only by finding their exact quote again. */
  'text-changed',
  /** The state declaration changed (parameters, frames, steps): saved settings may no longer apply. */
  'state-changed',
  /** The block became another type or version. */
  'type-changed',
  'removed',
] as const;
export type AnchorChange = (typeof ANCHOR_CHANGES)[number];

/**
 * `scroll-anchor-map.v1`: one entry for every block of the previous revision (none implicit), from
 * its id to its id in the next revision (or null when removed). Derived by code; moves of a block
 * to a new id are declared by the correction workflow and checked.
 */
export const AnchorMap = z.strictObject({
  schemaVersion: z.literal('scroll-anchor-map.v1'),
  assetId: OpaqueId,
  fromRevision: Revision,
  toRevision: Revision,
  entries: z
    .array(z.strictObject({ from: LocalId, to: LocalId.nullable(), change: z.enum(ANCHOR_CHANGES) }))
    .max(LIMITS.blocks),
});
export type AnchorMap = z.infer<typeof AnchorMap>;

function stateDeclaration(block: AnyBlock): string {
  switch (block.type) {
    case 'simulation':
      // The personal flag is part of the declaration: a snapshot's consent label depends on it.
      return canonicalJson(
        block.data.params.map((param) => [param.key, param.min, param.max, param.step, param.personal === true]),
      );
    case 'diagram':
      return canonicalJson([block.data.interaction.kind, block.data.frames.map((frame) => frame.id)]);
    case 'sequence':
      return canonicalJson(block.data.steps.map((step) => step.id));
    case 'paragraph':
    case 'subheading':
    case 'list':
    case 'quote':
    case 'callout':
    case 'disclosure':
    case 'code':
    case 'table':
    case 'figure':
    case 'media':
    case 'comparison':
    case 'timeline':
    case 'chart':
    case 'fallback':
      return '';
  }
}

/** A block's own content: envelope and data without its id, with disclosure children as ids. */
function ownContent(block: AnyBlock): string {
  const data =
    block.type === 'disclosure' ? { ...block.data, blocks: block.data.blocks.map((child) => child.id) } : block.data;
  return canonicalJson({ ...block, id: undefined, data });
}

function classify(previous: AnyBlock, next: AnyBlock | undefined): AnchorChange {
  if (next === undefined) return 'removed';
  if (next.type !== previous.type || next.version !== previous.version) return 'type-changed';
  if (ownContent(previous) === ownContent(next)) return 'same';
  if (projectText(previous) !== projectText(next)) return 'text-changed';
  if (stateDeclaration(previous) !== stateDeclaration(next)) return 'state-changed';
  return 'updated';
}

export type AnchorMapOutcome =
  | { readonly kind: 'derived'; readonly map: AnchorMap }
  | {
      readonly kind: 'invalid';
      readonly reason:
        'asset-mismatch' | 'revision-order' | 'move-unknown-source' | 'move-unknown-target' | 'move-conflict';
    };

/** Derives the anchor map from revision N to N+k, applying declared block moves. */
export function deriveAnchorMap(
  previous: ScrollDocument,
  next: ScrollDocument,
  options: { moves?: ReadonlyArray<{ readonly from: string; readonly to: string }> } = {},
): AnchorMapOutcome {
  if (previous.assetId !== next.assetId) return { kind: 'invalid', reason: 'asset-mismatch' };
  if (!(next.revision > previous.revision)) return { kind: 'invalid', reason: 'revision-order' };
  const previousBlocks = new Map<string, AnyBlock>();
  for (const visit of walkBlocks(previous.sections)) previousBlocks.set(visit.block.id, visit.block);
  const nextBlocks = new Map<string, AnyBlock>();
  for (const visit of walkBlocks(next.sections)) nextBlocks.set(visit.block.id, visit.block);

  const moves = new Map<string, string>();
  for (const move of options.moves ?? []) {
    if (!previousBlocks.has(move.from) || moves.has(move.from))
      return { kind: 'invalid', reason: 'move-unknown-source' };
    if (!nextBlocks.has(move.to)) return { kind: 'invalid', reason: 'move-unknown-target' };
    moves.set(move.from, move.to);
  }
  const targets = new Set<string>();
  const entries: Array<{ from: string; to: string | null; change: AnchorChange }> = [];
  for (const [id, block] of previousBlocks) {
    const targetId = moves.get(id) ?? id;
    const target = nextBlocks.get(targetId);
    const change = classify(block, target);
    const to = change === 'removed' ? null : targetId;
    if (to !== null) {
      if (targets.has(to)) return { kind: 'invalid', reason: 'move-conflict' };
      targets.add(to);
    }
    entries.push({ from: id, to, change });
  }
  return {
    kind: 'derived',
    map: {
      schemaVersion: 'scroll-anchor-map.v1',
      assetId: previous.assetId,
      fromRevision: previous.revision,
      toRevision: next.revision,
      entries,
    },
  };
}

export type RepointOutcome =
  /** The anchor holds: the block is identical (`change: 'same'`) under the same id. */
  | { readonly kind: 'same'; readonly change: 'same'; readonly locator: ScrollLocator }
  /**
   * The anchor still resolves, but something changed and the reader is told: the block moved to a
   * new id, its content was updated or its text rewritten (a passage whose exact quote was found
   * again), or its state declaration changed in a way the saved settings still fit.
   */
  | {
      readonly kind: 'remapped';
      readonly change: AnchorChange;
      readonly moved: boolean;
      readonly locator: ScrollLocator;
    }
  /** The block is still there but the shared settings no longer fit it (or their consent label changed); they are dropped. */
  | { readonly kind: 'state-reset'; readonly change: AnchorChange; readonly locator: ScrollBlockLocator }
  /** The moment is gone; the reader is told so and may open the section instead. */
  | {
      readonly kind: 'unavailable';
      readonly reason: 'block-removed' | 'block-type-changed' | 'passage-changed';
      readonly sectionId: string | null;
    }
  | { readonly kind: 'invalid'; readonly reason: 'map-mismatch' | 'locator-invalid' };

function personalKeys(block: AnyBlock): string {
  return canonicalJson(personalParamKeys(block).sort());
}

/**
 * Re-points a locator of the previous revision into the next one using the anchor map. The map
 * is trusted for one thing only, the pairing of ids (moves): its `change` for the pair is
 * recomputed from the two blocks and a map that disagrees is refused as `map-mismatch`. It never
 * moves a reference silently: `same` only when the map says the block is identical under the same
 * id; every other change is reported. A kept locator is always re-validated against the next
 * revision before it is returned.
 */
export function repointLocator(
  locator: ScrollLocator,
  previous: ScrollDocument,
  next: ScrollDocument,
  map: AnchorMap,
): RepointOutcome {
  if (
    map.assetId !== previous.assetId ||
    next.assetId !== previous.assetId ||
    map.fromRevision !== previous.revision ||
    map.toRevision !== next.revision
  ) {
    return { kind: 'invalid', reason: 'map-mismatch' };
  }
  if (validateLocator(previous, locator, { personalConsent: true }).kind !== 'valid') {
    return { kind: 'invalid', reason: 'locator-invalid' };
  }
  const entry = map.entries.find((candidate) => candidate.from === locator.blockId);
  const before = findBlock(previous, locator.blockId);
  if (entry === undefined || before === null) return { kind: 'invalid', reason: 'map-mismatch' };
  // The map is stored data and could be stale or forged. Its change is checked against the two
  // blocks themselves, so a map that calls a rewritten paragraph `same` is refused. What the map
  // is still trusted for is the pairing of ids: which block of the next revision a block of the
  // previous one became (a move declared by the correction workflow, `deriveAnchorMap`'s `moves`).
  const target = entry.to === null ? null : findBlock(next, entry.to);
  if (entry.to !== null && target === null) return { kind: 'invalid', reason: 'map-mismatch' };
  // Removed means the next revision has no block under that id (a declared move would have paired it).
  if (entry.to === null && findBlock(next, entry.from) !== null) return { kind: 'invalid', reason: 'map-mismatch' };
  if (classify(before.block, target?.block) !== entry.change) return { kind: 'invalid', reason: 'map-mismatch' };
  const sectionFallback = next.sections.some((section) => section.id === before.section.id) ? before.section.id : null;
  if (entry.change === 'removed' || entry.to === null) {
    return { kind: 'unavailable', reason: 'block-removed', sectionId: sectionFallback };
  }
  if (entry.change === 'type-changed')
    return { kind: 'unavailable', reason: 'block-type-changed', sectionId: sectionFallback };
  const after = findBlock(next, entry.to);
  if (after === null) return { kind: 'invalid', reason: 'map-mismatch' };
  const moved = entry.to !== entry.from;
  const change = entry.change;
  const kept = (result: ScrollLocator): RepointOutcome =>
    change === 'same' && !moved
      ? { kind: 'same', change: 'same', locator: result }
      : { kind: 'remapped', change, moved, locator: result };

  if (locator.kind === 'scroll_passage') {
    const oldText = projectText(before.block) ?? '';
    const newText = projectText(after.block);
    if (newText === null) return { kind: 'unavailable', reason: 'block-type-changed', sectionId: sectionFallback };
    const base = { ...locator, revision: next.revision, blockId: entry.to };
    const quote = oldText.slice(locator.start, locator.end);
    const candidate =
      newText === oldText
        ? base
        : (() => {
            const first = newText.indexOf(quote);
            return first < 0 || newText.indexOf(quote, first + 1) >= 0
              ? null
              : { ...base, start: first, end: first + quote.length };
          })();
    if (candidate === null || validateLocator(next, candidate).kind !== 'valid') {
      return { kind: 'unavailable', reason: 'passage-changed', sectionId: after.section.id };
    }
    return kept(candidate);
  }

  const base: ScrollBlockLocator = {
    kind: 'scroll_block',
    assetId: next.assetId,
    revision: next.revision,
    blockId: entry.to,
    blockType: after.block.type,
    blockVersion: after.block.version,
  };
  if (validateLocator(next, base).kind !== 'valid') return { kind: 'invalid', reason: 'map-mismatch' };
  if (locator.state === undefined) return kept(base);
  const withState: ScrollBlockLocator = { ...base, state: locator.state };
  const consentLabelHolds = personalKeys(before.block) === personalKeys(after.block);
  if (
    !consentLabelHolds ||
    blockStateProblems(after.block, locator.state.state, { partial: true }).length > 0 ||
    validateLocator(next, withState, { personalConsent: true }).kind !== 'valid'
  ) {
    return { kind: 'state-reset', change, locator: base };
  }
  return kept(withState);
}
