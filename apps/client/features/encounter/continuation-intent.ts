import type { ContinuationState, NavigateExperienceRequest } from '@knowscroll/contracts';

type ReadyContinuation = Extract<ContinuationState, { status: 'ready' }>;

/**
 * The navigation a ready, admitted continuation means. The displayed link and its immutable
 * target travel with it, so a stale card can never silently change destination.
 */
export function continuationIntent(
  state: ReadyContinuation,
  direction: 'next' | 'previous' = 'next',
): NavigateExperienceRequest['intent'] {
  const expectedContinuation = {
    linkId: state.linkId,
    assetId: state.target.assetId,
    assetRevision: state.target.assetRevision,
  };
  return state.relation.kind === 'series_step'
    ? { mode: 'series', direction, expectedContinuation }
    : { mode: 'related', expectedContinuation };
}

/** "Part 2" for a declared series step, "Related" for another angle. */
export function continuationLabel(state: ReadyContinuation): string {
  return state.relation.kind === 'series_step' ? `Part ${String(state.relation.part)}` : 'Related';
}

/** The name a screen reader hears for the move, which says where it goes. */
export function continuationName(state: ReadyContinuation, direction: 'next' | 'previous' = 'next'): string {
  const title = state.metadata.title;
  if (state.relation.kind === 'related_move') return `Another related explanation: ${title}`;
  const part = `Part ${String(state.relation.part)}`;
  return direction === 'previous' ? `Previous: ${part}, ${title}` : `Continue: ${part}, ${title}`;
}

export type { ReadyContinuation };
