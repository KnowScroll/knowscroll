import type { Kysely } from 'kysely';
import {
  negotiate,
  negotiateV2,
  parseDocument,
  parseDocumentV2,
  SCROLL_DOCUMENT_V2_SCHEMA_VERSION,
  type ScrollDocument,
  type ScrollDocumentV2,
} from '@knowscroll/scroll-model';
import type { Database } from '../../../infrastructure/postgres/database.js';
import type { RenderScroll } from '../public.js';
import { readStoredScrollDocument } from './postgres-store.js';

/**
 * Stored revisions are immutable, so a parsed document can be kept: parsing up to 128 KiB of JSON
 * through the schema on every read would cost for nothing. A small bounded cache, oldest first out.
 */
const CACHE_LIMIT = 32;

type Parsed = ScrollDocument | ScrollDocumentV2 | undefined;

/** Whether a stored document is a `scroll-document.v2`, by its declared schema. */
export function isScrollDocumentV2(stored: unknown): boolean {
  return (stored as { schemaVersion?: unknown } | null)?.schemaVersion === SCROLL_DOCUMENT_V2_SCHEMA_VERSION;
}

/** The stored document on the client path: structure and bounds, whichever schema it has. */
function parseStored(stored: unknown): Parsed {
  const parsed = isScrollDocumentV2(stored) ? parseDocumentV2(stored) : parseDocument(stored);
  return parsed.kind === 'valid' ? parsed.document : undefined;
}

/** Whether a client declaring `capabilities` can be given this stored Scroll document at all. */
export function canRenderScroll(stored: unknown, capabilities: unknown): boolean {
  const document = parseStored(stored);
  if (document === undefined) return false;
  return document.schemaVersion === SCROLL_DOCUMENT_V2_SCHEMA_VERSION
    ? negotiateV2(document, capabilities).kind === 'negotiated'
    : negotiate(document, capabilities).kind === 'negotiated';
}

/**
 * Creates `renderScroll` over one database: reads the stored consumer document of one revision (never
 * its provenance), parses it on the client path (structure and bounds; admission already proved the
 * rest) and negotiates it for the capabilities the client declared (D-012). A v1 document has the
 * blocks the client cannot render replaced by fallbacks, and the essential ones reported. A v2 document
 * is served whole to a client that declares `scroll-document.v2`, and is `cannot_render` for any
 * other (the caller may serve a v1 revision instead). Pure reads; no lock, no network.
 */
export function makeRenderScroll(db: Kysely<Database>): RenderScroll {
  const cache = new Map<string, NonNullable<Parsed>>();
  return async ({ assetId, revision, capabilities }) => {
    const key = `${assetId}@${String(revision)}`;
    let document = cache.get(key);
    if (document === undefined) {
      const stored = await readStoredScrollDocument(db, assetId, revision);
      if (stored === undefined) return { kind: 'not_found' };
      const parsed = parseStored(stored);
      if (parsed === undefined) return { kind: 'not_found' };
      document = parsed;
      if (cache.size >= CACHE_LIMIT) {
        const oldest = cache.keys().next();
        if (!oldest.done) cache.delete(oldest.value);
      }
      cache.set(key, document);
    }
    if (document.schemaVersion === SCROLL_DOCUMENT_V2_SCHEMA_VERSION) {
      const offered = negotiateV2(document, capabilities);
      switch (offered.kind) {
        case 'negotiated':
          return { kind: 'rendition', document: offered.document, degradedEssential: [] };
        case 'invalid-capabilities':
          return { kind: 'cannot_render', reason: 'capabilities_invalid' };
        case 'unsupported-document':
          return { kind: 'cannot_render', reason: 'unsupported_document' };
      }
    }
    const negotiated = negotiate(document, capabilities);
    switch (negotiated.kind) {
      case 'negotiated':
        return {
          kind: 'rendition',
          document: negotiated.document,
          degradedEssential: negotiated.degradedEssential.map((entry) => ({
            blockId: entry.blockId,
            originalType: entry.originalType,
          })),
        };
      case 'invalid-capabilities':
        return { kind: 'cannot_render', reason: 'capabilities_invalid' };
      case 'unsupported-document':
        return { kind: 'cannot_render', reason: 'unsupported_document' };
      case 'missing-baseline':
        return { kind: 'cannot_render', reason: 'missing_baseline' };
    }
  };
}
