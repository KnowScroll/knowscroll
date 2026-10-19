import { z } from 'zod';
import {
  BLOCK_TYPES,
  BLOCK_VERSIONS,
  type AnyBlock,
  type Block,
  type BlockType,
  type NestedBlock,
} from './blocks/catalog.js';
import { SCROLL_DOCUMENT_SCHEMA_VERSION, type ScrollDocument } from './document.js';
import { BlockTypeName, BlockVersionNumber } from './primitives.js';

/**
 * Version negotiation (blueprint §6 "the client advertises supported Scroll blocks; unsupported
 * rendering receives a fallback"). The server, not the client, chooses the rendition.
 */

/** What a client build can render: document schemas, and block type → supported versions. */
export const ClientCapabilities = z.strictObject({
  documentSchemas: z.array(z.string().min(1).max(40)).min(1).max(8),
  blocks: z
    .record(BlockTypeName, z.array(BlockVersionNumber).min(1).max(8))
    .refine((blocks) => Object.keys(blocks).length <= 64, { message: 'schema_too_big' }),
});
export type ClientCapabilities = z.infer<typeof ClientCapabilities>;

/** Every client must render these, so a fallback always has somewhere to land. */
export const BASELINE_BLOCKS = ['fallback', 'paragraph', 'subheading'] as const satisfies readonly BlockType[];

/** The capabilities of a client that implements all of scroll-document.v1. */
export const FULL_V1_CAPABILITIES: ClientCapabilities = {
  documentSchemas: [SCROLL_DOCUMENT_SCHEMA_VERSION],
  blocks: Object.fromEntries(BLOCK_TYPES.map((type) => [type, [BLOCK_VERSIONS[type]]])),
};

export interface Substitution {
  readonly blockId: string;
  readonly sectionId: string;
  readonly originalType: string;
  readonly originalVersion: number;
  readonly essential: boolean;
}

export type NegotiationOutcome =
  | {
      readonly kind: 'negotiated';
      /** The rendition for this client. It keeps the stored revision's integrity member. */
      readonly document: ScrollDocument;
      /** Every block replaced by a fallback (also the source of `scroll.render_fallback` diagnostics). */
      readonly substitutions: readonly Substitution[];
      /** Essential blocks the client will see only as fallback text, including ones inside a substituted disclosure. */
      readonly degradedEssential: readonly Substitution[];
    }
  | { readonly kind: 'unsupported-document'; readonly schemaVersion: string }
  | { readonly kind: 'missing-baseline'; readonly missing: readonly BlockType[] };

function supports(capabilities: ClientCapabilities, block: AnyBlock): boolean {
  const versions = Object.hasOwn(capabilities.blocks, block.type) ? capabilities.blocks[block.type] : undefined;
  return versions?.includes(block.version) ?? false;
}

function fallbackFor(block: AnyBlock): Extract<Block, { type: 'fallback' }> {
  return {
    id: block.id,
    type: 'fallback',
    version: 1,
    a11y: block.a11y,
    fallbackText: block.fallbackText,
    essential: block.essential,
    gesture: 'none',
    data: { originalType: block.type, originalVersion: block.version, reason: 'unsupported-by-client' },
  };
}

/**
 * Replaces every block the client cannot render with a `fallback` block that keeps its id,
 * accessibility text, essential flag and fallback text. Essential blocks are never dropped
 * silently: each one that degrades is listed so the caller can prefer another rendition (the Reel
 * variant, another Scroll) or label it "This part needs an app update · text version".
 */
export function negotiate(document: ScrollDocument, capabilities: ClientCapabilities): NegotiationOutcome {
  if (!capabilities.documentSchemas.includes(document.schemaVersion)) {
    return { kind: 'unsupported-document', schemaVersion: document.schemaVersion };
  }
  const missing = BASELINE_BLOCKS.filter((type) => !(capabilities.blocks[type] ?? []).includes(BLOCK_VERSIONS[type]));
  if (missing.length > 0) return { kind: 'missing-baseline', missing };

  const substitutions: Substitution[] = [];
  const degradedEssential: Substitution[] = [];
  const record = (block: AnyBlock, sectionId: string, list: Substitution[]) =>
    list.push({
      blockId: block.id,
      sectionId,
      originalType: block.type,
      originalVersion: block.version,
      essential: block.essential,
    });

  const sections = document.sections.map((section) => ({
    ...section,
    blocks: section.blocks.map((block): Block => {
      if (block.type === 'fallback') return block;
      if (!supports(capabilities, block)) {
        record(block, section.id, substitutions);
        if (block.essential) record(block, section.id, degradedEssential);
        if (block.type === 'disclosure') {
          for (const child of block.data.blocks) if (child.essential) record(child, section.id, degradedEssential);
        }
        return fallbackFor(block);
      }
      if (block.type !== 'disclosure') return block;
      const children = block.data.blocks.map((child): NestedBlock => {
        if (child.type === 'fallback' || supports(capabilities, child)) return child;
        record(child, section.id, substitutions);
        if (child.essential) record(child, section.id, degradedEssential);
        return fallbackFor(child);
      });
      return { ...block, data: { ...block.data, blocks: children } };
    }),
  }));
  return { kind: 'negotiated', document: { ...document, sections }, substitutions, degradedEssential };
}
