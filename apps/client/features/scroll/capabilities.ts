import type { ClientCapabilities } from '@knowscroll/contracts';
import { SCROLL_DOCUMENT_V2_SCHEMA_VERSION, SCROLL_DOCUMENT_V3_SCHEMA_VERSION } from '@knowscroll/scroll-model';
import { SCROLL_RENDERER_CAPABILITIES } from '@knowscroll/ui';

/** Every supported block/version declared by the actual Scroll renderer registry (D-012). */
export { SCROLL_RENDERER_CAPABILITIES as SCROLL_CAPABILITIES };

/**
 * What a surface that draws Folio's essay declares: the same blocks, `scroll-document.v2` (D-129) and
 * `scroll-document.v3` (#762, #763). Neither has block types to substitute, so a client that does not declare one is
 * never sent it (the server offers it an earlier revision of the same Scroll in a version it declared, or nothing).
 */
export const SCROLL_FOLIO_CAPABILITIES: ClientCapabilities = {
  ...SCROLL_RENDERER_CAPABILITIES,
  documentSchemas: [
    ...SCROLL_RENDERER_CAPABILITIES.documentSchemas,
    SCROLL_DOCUMENT_V2_SCHEMA_VERSION,
    SCROLL_DOCUMENT_V3_SCHEMA_VERSION,
  ],
};
