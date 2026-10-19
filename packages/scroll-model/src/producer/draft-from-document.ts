import type { AnyBlock } from '../blocks/catalog.js';
import { findBlock, type ScrollDocument } from '../document.js';
import type { ProvenanceBinding } from '../internal/provenance.js';
import { projectText } from '../registry.js';
import {
  SCROLL_DRAFT_VERSION,
  type DraftBinding,
  type DraftBlock,
  type DraftNestedBlock,
  type ScrollDraft,
} from './draft.js';

/**
 * The draft that compiles back to `document` (with the provenance bindings it was compiled with).
 * Used to offer the previous revision to the writer for a correction ("keep the ids of unchanged
 * blocks"), and to prove compile is idempotent. A stored document never holds `fallback` blocks;
 * passing a client rendition is a programming error.
 */
export function draftFromDocument(document: ScrollDocument, bindings: readonly ProvenanceBinding[] = []): ScrollDraft {
  const toDraft = (block: AnyBlock): DraftBlock => {
    if (block.type === 'fallback') throw new TypeError('draftFromDocument: renditions are not drafts');
    const envelope = { id: block.id, a11y: block.a11y, fallbackText: block.fallbackText, essential: block.essential };
    if (block.type === 'disclosure') {
      return {
        ...envelope,
        type: 'disclosure',
        data: { ...block.data, blocks: block.data.blocks.map((child) => toDraft(child) as DraftNestedBlock) },
      };
    }
    // Same pairing of type and data as the document block; only version and gesture are dropped.
    return { ...envelope, type: block.type, data: block.data } as DraftBlock;
  };
  const draftBindings = bindings.map((binding): DraftBinding => {
    if (binding.kind !== 'passage') return binding;
    const visit = findBlock(document, binding.blockId);
    const text = visit === null ? null : projectText(visit.block);
    return {
      kind: 'passage',
      claimId: binding.claimId,
      blockId: binding.blockId,
      anchorText: text === null ? '' : text.slice(binding.start, binding.end),
    };
  });
  return {
    draftVersion: SCROLL_DRAFT_VERSION,
    title: document.title,
    dek: document.dek,
    sections: document.sections.map((section) => ({
      id: section.id,
      heading: section.heading,
      blocks: section.blocks.map(toDraft),
    })),
    bindings: draftBindings,
  };
}
