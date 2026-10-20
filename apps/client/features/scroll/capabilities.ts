import type { ClientCapabilities } from '@knowscroll/scroll-model';

/**
 * What this build can render, declared when it opens an exposure so the server negotiates the
 * document for it (D-012): the text-family blocks and the server-emitted fallback. Every client
 * must render the baseline (`fallback`, `paragraph`, `subheading`). Blocks this build cannot draw
 * (diagrams, charts, simulations ...) arrive as readable fallbacks, never blank areas.
 *
 * TEMPORARY with `temporary-article.tsx`: once the renderers in `packages/ui/src/scroll` land, this
 * becomes the renderer's own `SCROLL_RENDERER_CAPABILITIES`.
 */
export const SCROLL_CAPABILITIES: ClientCapabilities = {
  documentSchemas: ['scroll-document.v1'],
  blocks: {
    fallback: [1],
    paragraph: [1],
    subheading: [1],
    list: [1],
    quote: [1],
    callout: [1],
    disclosure: [1],
  },
};
