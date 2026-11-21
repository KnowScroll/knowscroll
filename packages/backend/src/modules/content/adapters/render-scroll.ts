import type { Kysely } from 'kysely';
import {
  negotiate,
  negotiateV2,
  negotiateV3,
  parseDocument,
  parseDocumentV2,
  parseDocumentV3,
  SCROLL_DOCUMENT_V2_SCHEMA_VERSION,
  SCROLL_DOCUMENT_V3_SCHEMA_VERSION,
  type ScrollDocument,
  type ScrollDocumentV2,
  type ScrollDocumentV3,
} from '@knowscroll/scroll-model';
import type { Database } from '../../../infrastructure/postgres/database.js';
import type { RenderScroll } from '../public.js';
import { readStoredScrollDocument } from './postgres-store.js';
import { isRetiredRevision } from './retirement-sql.js';

/**
 * Stored revisions are immutable, so a parsed document can be kept: parsing up to 128 KiB of JSON
 * through the schema on every read would cost for nothing. A small bounded cache, oldest first out.
 */
const CACHE_LIMIT = 32;

type Parsed = ScrollDocument | ScrollDocumentV2 | ScrollDocumentV3 | undefined;

/** Whether a stored document is a `scroll-document.v2`, by its declared schema. */
export function isScrollDocumentV2(stored: unknown): boolean {
  return (stored as { schemaVersion?: unknown } | null)?.schemaVersion === SCROLL_DOCUMENT_V2_SCHEMA_VERSION;
}

/** Whether a stored document is a `scroll-document.v3`, by its declared schema. */
export function isScrollDocumentV3(stored: unknown): boolean {
  return (stored as { schemaVersion?: unknown } | null)?.schemaVersion === SCROLL_DOCUMENT_V3_SCHEMA_VERSION;
}

/** The stored document on the client path: structure and bounds, whichever schema it has. */
function parseStored(stored: unknown): Parsed {
  const parsed = isScrollDocumentV3(stored)
    ? parseDocumentV3(stored)
    : isScrollDocumentV2(stored)
      ? parseDocumentV2(stored)
      : parseDocument(stored);
  return parsed.kind === 'valid' ? parsed.document : undefined;
}

/** Whether a client declaring `capabilities` can be given this stored Scroll document at all. */
export function canRenderScroll(stored: unknown, capabilities: unknown): boolean {
  const document = parseStored(stored);
  if (document === undefined) return false;
  if (document.schemaVersion === SCROLL_DOCUMENT_V3_SCHEMA_VERSION)
    return negotiateV3(document, capabilities).kind === 'negotiated';
  if (document.schemaVersion === SCROLL_DOCUMENT_V2_SCHEMA_VERSION)
    return negotiateV2(document, capabilities).kind === 'negotiated';
  return negotiate(document, capabilities).kind === 'negotiated';
}

/**
 * Creates `renderScroll` over one database: reads the stored consumer document of one revision (never
 * its provenance), parses it on the client path (structure and bounds; admission already proved the
 * rest) and negotiates it for the capabilities the client declared (D-012). A v1 document has the
 * blocks the client cannot render replaced by fallbacks, and the essential ones reported. A v2 or v3 document
 * is served whole to a client that declares its schema, and is `cannot_render` for any other (the caller
 * may serve an earlier revision instead). A revision that a later document v3 retired (D-435) is `not_found`, as
 * any revision that cannot be read is, and the cache never answers for it. Pure reads; no lock, no network.
 */
export function makeRenderScroll(db: Kysely<Database>): RenderScroll {
  const cache = new Map<string, NonNullable<Parsed>>();
  return async ({ assetId, revision, capabilities }) => {
    const key = `${assetId}@${String(revision)}`;
    // A stored revision never changes, but whether it is retired does (a later v3 retires it, D-435), so the cache is asked after this and never instead of it.
    if (await isRetiredRevision(db, assetId, revision)) return { kind: 'not_found' };
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
    if (document.schemaVersion === SCROLL_DOCUMENT_V3_SCHEMA_VERSION) {
      const offered = negotiateV3(document, capabilities);
      switch (offered.kind) {
        case 'negotiated':
          return { kind: 'rendition', document: offered.document, degradedEssential: [] };
        case 'invalid-capabilities':
          return { kind: 'cannot_render', reason: 'capabilities_invalid' };
        case 'unsupported-document':
          return { kind: 'cannot_render', reason: 'unsupported_document' };
      }
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
