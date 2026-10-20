/**
 * What a Scroll reader reports about reading, and nothing else (blueprint §18, shared interaction
 * recorder). The article measures and reports; the recorder in `client-core` (#229) implements
 * this interface, aggregates, buffers and sends. No raw pointer frames, scroll offsets, text or
 * parameter values ever cross it: a block is named by its id and an interaction by its kind.
 *
 * The shape is a contract between the renderer (this package) and the recorder: do not change it
 * without saying so in the PR that does.
 */
export interface ScrollReadingObserver {
  /** Visible fraction (0..1) of a block's area inside the reading viewport changed by ≥ 0.1, crossed 0, 0.5 or 1, or the block mounted/unmounted. `at` = monotonic ms (performance.now()). */
  onBlockVisibility(event: { readonly blockId: string; readonly visibleFraction: number; readonly at: number }): void;
  /** A deliberate interaction; never raw pointer frames. */
  onBlockInteraction(event: {
    readonly blockId: string;
    readonly kind: 'control' | 'step' | 'disclosure' | 'drag' | 'copy' | 'text_version' | 'retry';
    readonly at: number;
  }): void;
  /** The article became active or inactive (app backgrounded, tab hidden, an overlay opened or closed). */
  onActivity(event: { readonly active: boolean; readonly at: number }): void;
}

/** The interaction kinds a block may report. */
export type ScrollInteractionKind = Parameters<ScrollReadingObserver['onBlockInteraction']>[0]['kind'];

/**
 * An internal diagnostic: a block did not render as authored and a readable stand-in was shown
 * (`scroll.render_fallback`). It is for engineers, never shown to the reader, and carries no
 * block text. `at` is monotonic ms.
 */
export interface ScrollRenderDiagnostic {
  readonly blockId: string;
  /** The block's type as the document names it, or `unknown` when even that was unreadable. */
  readonly blockType: string;
  readonly reason:
    | 'unsupported-by-client'
    | 'unknown-type'
    | 'unknown-version'
    | 'invalid-block'
    | 'render-error'
    | 'non-finite-output';
  readonly at: number;
}

export interface ScrollDiagnostics {
  onRenderFallback(event: ScrollRenderDiagnostic): void;
}
