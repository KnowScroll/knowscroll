import type { AnyBlock, Block } from './blocks/catalog.js';
import { fallbackTextOf } from './registry.js';

/**
 * The `fallback` block that stands in for `block` in a client rendition: same id, accessibility
 * text and essential flag, its fallback text (derived for text blocks), no gesture.
 */
export function fallbackBlockFor(block: AnyBlock): Extract<Block, { type: 'fallback' }> {
  return {
    id: block.id,
    type: 'fallback',
    version: 1,
    a11y: block.a11y,
    fallbackText: fallbackTextOf(block),
    essential: block.essential,
    gesture: 'none',
    data: { originalType: block.type, originalVersion: block.version, reason: 'unsupported-by-client' },
  };
}
