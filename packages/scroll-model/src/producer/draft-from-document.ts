import type { AnyBlock } from '../blocks/catalog.js';
import { findBlock, type ScrollDocument } from '../document.js';
import type { ProvenanceBinding } from '../internal/provenance.js';
import { isTextBlockType, textFields } from '../registry.js';
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
    if (isTextBlockType(block.type)) {
      // Same pairing of type and data as the document block; code derives the rest.
      return { id: block.id, type: block.type, essential: block.essential, data: block.data } as DraftBlock;
    }
    const envelope = {
      id: block.id,
      a11y: block.a11y,
      fallbackText: 'fallbackText' in block ? block.fallbackText : undefined,
      essential: block.essential,
    };
    if (block.type === 'disclosure') {
      return {
        ...envelope,
        type: 'disclosure',
        data: { ...block.data, blocks: block.data.blocks.map((child) => toDraft(child) as DraftNestedBlock) },
      };
    }
    if (block.type === 'simulation') {
      return {
        ...envelope,
        type: 'simulation',
        data: { ...block.data, illustrative: block.data.illustrative !== false },
      };
    }
    // Same pairing of type and data as the document block; only version and gesture are dropped.
    return { ...envelope, type: block.type, data: block.data } as DraftBlock;
  };
  const headings = new Map(document.sections.map((section) => [section.id, section.heading ?? '']));
  const draftBindings = bindings.map((binding): DraftBinding => {
    switch (binding.kind) {
      case 'constant':
      case 'value':
      case 'block':
        return binding;
      case 'header':
        return {
          kind: 'header',
          claimId: binding.claimId,
          field: binding.field,
          anchorText: document[binding.field].slice(binding.start, binding.end),
        };
      case 'heading':
        return {
          kind: 'heading',
          claimId: binding.claimId,
          sectionId: binding.sectionId,
          anchorText: (headings.get(binding.sectionId) ?? '').slice(binding.start, binding.end),
        };
      case 'passage': {
        const visit = findBlock(document, binding.blockId);
        const text =
          visit === null ? '' : (textFields(visit.block).find((field) => field.field === binding.field)?.text ?? '');
        return {
          kind: 'passage',
          claimId: binding.claimId,
          blockId: binding.blockId,
          ...(binding.field === 'text' ? {} : { field: binding.field }),
          anchorText: text.slice(binding.start, binding.end),
        };
      }
    }
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
