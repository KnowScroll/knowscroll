import type { ScrollDiagnostics, ScrollReadingObserver, ScrollRenderDiagnostic } from '@knowscroll/ui';

/** What the gallery's article reported, for the browser smoke to read (`window.__ksScrollGallery`). */
export interface ScrollGalleryEvents {
  visibility: { blockId: string; visibleFraction: number }[];
  interactions: { blockId: string; kind: string }[];
  activity: { active: boolean }[];
  diagnostics: Pick<ScrollRenderDiagnostic, 'blockId' | 'blockType' | 'reason'>[];
}

export const galleryEvents: ScrollGalleryEvents = { visibility: [], interactions: [], activity: [], diagnostics: [] };

/** The recorder's three events, kept in memory (the real recorder arrives with #229). */
export const galleryObserver: ScrollReadingObserver = {
  onBlockVisibility: ({ blockId, visibleFraction }) => {
    galleryEvents.visibility.push({ blockId, visibleFraction });
  },
  onBlockInteraction: ({ blockId, kind }) => {
    galleryEvents.interactions.push({ blockId, kind });
  },
  onActivity: ({ active }) => {
    galleryEvents.activity.push({ active });
  },
};

export const galleryDiagnostics: ScrollDiagnostics = {
  onRenderFallback: ({ blockId, blockType, reason }) => {
    galleryEvents.diagnostics.push({ blockId, blockType, reason });
  },
};
