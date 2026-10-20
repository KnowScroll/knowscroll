/**
 * What a Scroll renderer reports while a person reads (blueprint §18 "Shared interaction recorder").
 * It is **structurally identical** to `ScrollReadingObserver` in `packages/ui/src/scroll/observer.ts`
 * (owned by the renderer work): client-core never imports `ui`, the client app hands the recorder's
 * observer to the article, and TypeScript checks the shapes agree where it does.
 *
 * Times are monotonic milliseconds (`performance.now()`): a client's wall clock never decides what
 * was seen. Events are summaries (a visibility change of at least a tenth, a crossing of 0, 0.5 or 1,
 * a mount or unmount), never raw pointer or scroll frames.
 */
export interface ReadingObserver {
  /**
   * The visible fraction (0..1) of a block's area inside the reading viewport changed by at least
   * 0.1, crossed 0, 0.5 or 1, or the block mounted or unmounted.
   */
  onBlockVisibility(event: { readonly blockId: string; readonly visibleFraction: number; readonly at: number }): void;
  /** A deliberate interaction; never raw pointer frames, never a value. */
  onBlockInteraction(event: {
    readonly blockId: string;
    readonly kind: 'control' | 'step' | 'disclosure' | 'drag' | 'copy' | 'text_version' | 'retry';
    readonly at: number;
  }): void;
  /** The article became active or inactive (app backgrounded, tab hidden, an overlay opened or closed). */
  onActivity(event: { readonly active: boolean; readonly at: number }): void;
}
