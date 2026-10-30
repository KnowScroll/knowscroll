import type { ClientCapabilities } from '@knowscroll/contracts';
import { SCROLL_RENDERER_CAPABILITIES } from '@knowscroll/ui';

/** Every supported block/version declared by the actual Scroll renderer registry (D-012). */
export { SCROLL_RENDERER_CAPABILITIES as SCROLL_CAPABILITIES };

/**
 * What a surface that draws the Stage + Spine reader declares: the same blocks, and `scroll-document.v2`
 * (D-129). A v2 document has no block types to substitute, so a client that does not declare it is
 * never sent one (the server offers it an earlier v1 revision of the same Scroll, or nothing).
 */
export const STAGE_CAPABILITIES: ClientCapabilities = {
  ...SCROLL_RENDERER_CAPABILITIES,
  documentSchemas: [...SCROLL_RENDERER_CAPABILITIES.documentSchemas, 'scroll-document.v2'],
};
