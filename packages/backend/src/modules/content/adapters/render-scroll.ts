import type { Kysely } from 'kysely';
import { negotiate, parseDocument, type ScrollDocument } from '@knowscroll/scroll-model';
import type { Database } from '../../../infrastructure/postgres/database.js';
import type { RenderScroll } from '../public.js';
import { readStoredScrollDocument } from './postgres-store.js';

/**
 * Stored revisions are immutable, so a parsed document can be kept: parsing up to 128 KiB of JSON
 * through the schema on every read would cost for nothing. A small bounded cache, oldest first out.
 */
const CACHE_LIMIT = 32;

/**
 * Creates `renderScroll` over one database: reads the stored consumer document of one revision (never
 * its provenance), parses it on the client path (structure and bounds; admission already proved the
 * simulations) and negotiates it for the capabilities the client declared (D-012): blocks the client
 * cannot render become fallbacks, essential ones are reported. Pure reads; no lock, no network.
 */
export function makeRenderScroll(db: Kysely<Database>): RenderScroll {
  const cache = new Map<string, ScrollDocument>();
  return async ({ assetId, revision, capabilities }) => {
    const key = `${assetId}@${String(revision)}`;
    let document = cache.get(key);
    if (document === undefined) {
      const stored = await readStoredScrollDocument(db, assetId, revision);
      if (stored === undefined) return { kind: 'not_found' };
      const parsed = parseDocument(stored);
      if (parsed.kind !== 'valid') return { kind: 'not_found' };
      document = parsed.document;
      if (cache.size >= CACHE_LIMIT) {
        const oldest = cache.keys().next();
        if (!oldest.done) cache.delete(oldest.value);
      }
      cache.set(key, document);
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
