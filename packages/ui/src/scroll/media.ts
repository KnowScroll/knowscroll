import type { ReactNode } from 'react';
import type { MediaRef } from '@knowscroll/scroll-model';

/** What a figure or clip asks the app to draw (admitted media; the pipeline arrives with S2.4). */
export interface ScrollMediaRequest {
  readonly kind: 'still' | 'loop' | 'video' | 'audio';
  readonly media: MediaRef;
  readonly alt: string;
  readonly poster?: MediaRef | undefined;
  readonly captions?: MediaRef | undefined;
  readonly durationMs?: number | undefined;
  /** The reader asked for reduced motion: show the poster, never autoplay or loop. */
  readonly reducedMotion: boolean;
}

/**
 * Draws admitted media. Return null while the asset is not available: the block then shows its
 * placeholder, which carries the alt text, so a figure is never a blank. Until the media pipeline
 * exists nothing is passed and every figure is a placeholder.
 */
export type ScrollMediaRenderer = (request: ScrollMediaRequest) => ReactNode;
