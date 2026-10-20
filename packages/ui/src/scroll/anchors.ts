import { findBlock, type ScrollDocument } from '@knowscroll/scroll-model';

const BLOCK_ID = /^[a-z][a-z0-9-]{1,39}$/;

/**
 * The block id in an address fragment (`#why-squared` or `why-squared`), or null when the
 * fragment is not a block id. An anchor is a block id, never a pixel offset (E02 "Restore").
 */
export function parseBlockAnchor(fragment: string): string | null {
  const id = fragment.startsWith('#') ? fragment.slice(1) : fragment;
  return BLOCK_ID.test(id) ? id : null;
}

/** The address fragment that names a block. */
export function formatBlockAnchor(blockId: string): string {
  return `#${blockId}`;
}

export interface AnchorTarget {
  /** The top-level block to scroll to: the block itself, or the disclosure holding it. */
  readonly scrollToBlockId: string;
  /** The disclosure that has to be open for the block to be on screen, if it is nested. */
  readonly openDisclosureId: string | null;
}

/**
 * Where a block id leads in this revision: its own block, or, for a block inside a disclosure,
 * the disclosure (opened). Null when the revision has no such block; the caller then falls back to
 * the section heading or the top, as the E02 restore note says.
 */
export function resolveAnchor(document: Pick<ScrollDocument, 'sections'>, blockId: string): AnchorTarget | null {
  const visit = findBlock(document, blockId);
  if (visit === null) return null;
  if (visit.parent === null) return { scrollToBlockId: blockId, openDisclosureId: null };
  return { scrollToBlockId: visit.parent.id, openDisclosureId: visit.parent.id };
}
