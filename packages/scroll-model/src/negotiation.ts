import { z } from 'zod';
import {
  BLOCK_TYPES,
  BLOCK_VERSIONS,
  type AnyBlock,
  type Block,
  type BlockType,
  type NestedBlock,
} from './blocks/catalog.js';
import { INTEGRITY_METHOD, SCROLL_DOCUMENT_SCHEMA_VERSION, type ScrollDocument } from './document.js';
import { fallbackBlockFor } from './fallback.js';
import { issueFromSchema, uniqueIssues, type Issue } from './issues.js';
import { FIELD_LIMITS } from './limits.js';
import { BlockTypeName, BlockVersionNumber } from './primitives.js';
import { BASELINE_TYPES } from './registry.js';
import { computeIntegrity } from './validate.js';

/**
 * Version negotiation (blueprint §6 "the client advertises supported Scroll blocks; unsupported
 * rendering receives a fallback"). The server, not the client, chooses the rendition.
 */

/** What a client build can render: document schemas, and block type → supported versions. */
export const ClientCapabilities = z.strictObject({
  documentSchemas: z.array(z.string().min(1).max(40)).min(1).max(8),
  blocks: z
    .record(BlockTypeName, z.array(BlockVersionNumber).min(1).max(8))
    .refine((blocks) => Object.keys(blocks).length <= FIELD_LIMITS.capabilityTypes, { message: 'schema_too_big' }),
});
export type ClientCapabilities = z.infer<typeof ClientCapabilities>;

/** Every client must render these, so a fallback always has somewhere to land. */
export const BASELINE_BLOCKS = BASELINE_TYPES;

/** The capabilities of a client that implements all of scroll-document.v1. */
export const FULL_V1_CAPABILITIES: ClientCapabilities = {
  documentSchemas: [SCROLL_DOCUMENT_SCHEMA_VERSION],
  blocks: Object.fromEntries(BLOCK_TYPES.map((type) => [type, [BLOCK_VERSIONS[type]]])),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parses capabilities a client sent. The number of advertised types is checked before the schema
 * runs, so a hostile value with hundreds of thousands of keys costs one `Object.keys`.
 */
export function parseCapabilities(
  input: unknown,
):
  | { readonly kind: 'capabilities'; readonly capabilities: ClientCapabilities }
  | { readonly kind: 'invalid'; readonly issues: readonly Issue[] } {
  if (!isRecord(input)) return { kind: 'invalid', issues: [{ code: 'schema_invalid_type', path: '$' }] };
  const blocks = input['blocks'];
  if (isRecord(blocks) && Object.keys(blocks).length > FIELD_LIMITS.capabilityTypes) {
    return { kind: 'invalid', issues: [{ code: 'schema_too_big', path: 'blocks' }] };
  }
  const parsed = ClientCapabilities.safeParse(input);
  return parsed.success
    ? { kind: 'capabilities', capabilities: parsed.data }
    : { kind: 'invalid', issues: uniqueIssues(parsed.error.issues.map(issueFromSchema)) };
}

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
      /**
       * The rendition for this client. Unchanged (the stored revision) when nothing was substituted;
       * otherwise it carries `rendition {of, sha256}` so the client can verify what it received.
       */
      readonly document: ScrollDocument;
      /** Every block replaced by a fallback (also the source of `scroll.render_fallback` diagnostics). */
      readonly substitutions: readonly Substitution[];
      /** Essential blocks the client will see only as fallback text, including ones inside a substituted disclosure. */
      readonly degradedEssential: readonly Substitution[];
    }
  | { readonly kind: 'invalid-capabilities'; readonly issues: readonly Issue[] }
  | { readonly kind: 'unsupported-document'; readonly schemaVersion: string }
  | { readonly kind: 'missing-baseline'; readonly missing: readonly BlockType[] };

function supports(capabilities: ClientCapabilities, block: AnyBlock): boolean {
  const versions = Object.hasOwn(capabilities.blocks, block.type) ? capabilities.blocks[block.type] : undefined;
  return versions?.includes(block.version) ?? false;
}

/**
 * Replaces every block the client cannot render with a `fallback` block that keeps its id,
 * accessibility text, essential flag and fallback text (derived for text blocks). Essential blocks
 * are never dropped silently: each one that degrades is listed so the caller can prefer another
 * rendition (the Reel variant, another Scroll) or label it "This part needs an app update · text
 * version". The capabilities are untrusted client input and are parsed here. A rendition of a
 * valid stored document is always valid (`validateDocument` bounds the worst rendition).
 */
export function negotiate(document: ScrollDocument, capabilitiesInput: unknown): NegotiationOutcome {
  const parsed = parseCapabilities(capabilitiesInput);
  if (parsed.kind === 'invalid') return { kind: 'invalid-capabilities', issues: parsed.issues };
  const capabilities = parsed.capabilities;
  if (!capabilities.documentSchemas.includes(document.schemaVersion)) {
    return { kind: 'unsupported-document', schemaVersion: document.schemaVersion };
  }
  const missing = BASELINE_TYPES.filter((type) => {
    const versions = Object.hasOwn(capabilities.blocks, type) ? capabilities.blocks[type] : undefined;
    return !(versions ?? []).includes(BLOCK_VERSIONS[type]);
  });
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
        return fallbackBlockFor(block);
      }
      if (block.type !== 'disclosure') return block;
      const children = block.data.blocks.map((child): NestedBlock => {
        if (child.type === 'fallback' || supports(capabilities, child)) return child;
        record(child, section.id, substitutions);
        if (child.essential) record(child, section.id, degradedEssential);
        return fallbackBlockFor(child);
      });
      return { ...block, data: { ...block.data, blocks: children } };
    }),
  }));
  if (substitutions.length === 0) return { kind: 'negotiated', document, substitutions, degradedEssential };
  const unsigned: ScrollDocument = { ...document, sections, rendition: undefined };
  const rendition = {
    method: INTEGRITY_METHOD,
    of: document.integrity.sha256,
    sha256: computeIntegrity(unsigned),
  } as const;
  const { rendition: _unsigned, ...content } = unsigned;
  return { kind: 'negotiated', document: { ...content, rendition }, substitutions, degradedEssential };
}
