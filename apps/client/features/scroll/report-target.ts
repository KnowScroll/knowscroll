import type { FeedbackTarget } from '@knowscroll/client-core';
import type { OpenedScrollFolio } from './scroll-session';

/**
 * What a report from an opened Folio Scroll is about: the exact revision and, when the reader knows where the person
 * was, the stop (or, for a v3 Scroll, the beat) on screen, so the report names the place and not only the Scroll. A
 * report about a Quick answer also names the answer, whose words the server keeps with the report (D-255).
 */
export function reportTargetOf(
  scroll: OpenedScrollFolio,
  placeId: string | undefined,
  quickAnswerId?: string,
): FeedbackTarget {
  return {
    kind: 'asset',
    assetId: scroll.assetId,
    assetRevision: scroll.assetRevision,
    title: scroll.document.title,
    format: 'scroll',
    ...(placeId === undefined ? {} : { anchor: { kind: 'scroll' as const, blockId: placeId } }),
    ...(quickAnswerId === undefined ? {} : { quickAnswerId }),
  };
}
