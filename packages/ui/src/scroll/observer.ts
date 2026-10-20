/**
 * What a Scroll reader reports about reading, and nothing else (blueprint §18, shared interaction
 * recorder). The article measures and reports; the recorder in `client-core` (#229) implements
 * this interface, aggregates, buffers and sends. No raw pointer frames, scroll offsets, text or
 * parameter values ever cross it: a block is named by its id and an interaction by its kind.
 *
 * The shape is a contract between the renderer (this package) and the recorder: do not change it
 * without saying so in the PR that does.
 *
 * ONE interaction vocabulary: `INTERACTION_KINDS` of `@knowscroll/scroll-model`, per block type and
 * free of values. The recorder passes `{ blockId, blockType, kind }` to the package's
 * `blockInteractionPayload` (which refuses a kind the type does not declare), so what this
 * interface reports is exactly what the recorder can send.
 */
import type { INTERACTION_KINDS } from '@knowscroll/scroll-model';

/** The block types that declare interaction kinds (the keys of the package's `INTERACTION_KINDS`). */
export type InteractionBlockType = keyof typeof INTERACTION_KINDS;

/** The kinds block type `T` may report (`INTERACTION_KINDS[T]`). */
export type InteractionKindOf<T extends InteractionBlockType> = (typeof INTERACTION_KINDS)[T][number];

/** The union of every `INTERACTION_KINDS` value. */
export type ScrollInteractionKind = InteractionKindOf<InteractionBlockType>;

/**
 * One deliberate interaction. A discriminated union over the block type, so `{ blockType: 'code',
 * kind: 'step-changed' }` does not compile; it is assignable to `{ blockId; blockType; kind: <the
 * union of INTERACTION_KINDS values>; at }`.
 */
export type ScrollInteraction = {
  [T in InteractionBlockType]: {
    readonly blockId: string;
    readonly blockType: T;
    readonly kind: InteractionKindOf<T>;
    readonly at: number;
  };
}[InteractionBlockType];

export interface ScrollReadingObserver {
  /** Visible fraction (0..1): visible height / min(block height, reading viewport height) changed by ≥ 0.1, crossed 0, 0.5 or 1, or the block mounted/unmounted. `at` = monotonic ms (performance.now()). */
  onBlockVisibility(event: { readonly blockId: string; readonly visibleFraction: number; readonly at: number }): void;
  /** A deliberate interaction; never raw pointer frames, never a value. A fallback's Retry is not one (see `ScrollDiagnostics`). */
  onBlockInteraction(event: ScrollInteraction): void;
  /** The article became active or inactive (app backgrounded, tab hidden, an overlay opened or closed). */
  onActivity(event: { readonly active: boolean; readonly at: number }): void;
}

/**
 * An internal diagnostic: a block did not render as authored and a readable stand-in was shown
 * (`scroll.render_fallback`). It is for engineers, never shown to the reader, and carries no
 * block text. `at` is monotonic ms.
 */
export interface ScrollRenderDiagnostic {
  readonly blockId: string;
  /**
   * The block's type as the document names it, or `unknown` when even that was unreadable. For an
   * unknown type this is a string from the document: untrusted, never shown; the recorder must
   * whitelist or truncate it before it leaves the device.
   */
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

/** The reader pressed Retry on a block that failed to render. A diagnostic for engineers, not a reader interaction. */
export interface ScrollRetryDiagnostic {
  readonly blockId: string;
  readonly blockType: string;
  readonly at: number;
}

export interface ScrollDiagnostics {
  onRenderFallback(event: ScrollRenderDiagnostic): void;
  /** Optional: Retry on a block that threw while rendering. */
  onFallbackRetry?(event: ScrollRetryDiagnostic): void;
}
