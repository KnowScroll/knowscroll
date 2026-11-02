import type { ExposureContextResponse } from '@knowscroll/contracts';
import type { NextPartPeek } from '@knowscroll/ui';
import { continuationLabel, type ReadyContinuation } from './continuation-intent';

/** The moves a v2 Scroll's reader offers from what the server admitted for it (D-134, D-184). */
export interface ReaderContinuations {
  readonly nextPart?: NextPartPeek | undefined;
  readonly related?: NextPartPeek | undefined;
  readonly previousPart?: (() => void) | undefined;
  /** The Part before as the reader names it ("Part 1", its title): the tab at the picture's edge and the Part a swipe right brings in. */
  readonly previous?: NextPartPeek | undefined;
}

/**
 * Turns the context's continuations into the reader's moves. Only a ready, admitted continuation is a
 * move; `go` is how the screen follows one (the encounter session's navigation with the displayed link,
 * or the address of the target on `/scroll/<id>`). A move that is not admitted is absent, so there is no
 * button, no key and no swipe for it.
 */
export function readerContinuations(
  continuations: ExposureContextResponse['continuations'],
  go: (state: ReadyContinuation, direction: 'next' | 'previous') => void,
): ReaderContinuations {
  const { seriesNext, seriesPrevious, related } = continuations;
  const peek = (state: ReadyContinuation, direction: 'next' | 'previous' = 'next'): NextPartPeek => ({
    label: continuationLabel(state),
    title: state.metadata.title,
    related: state.relation.kind === 'related_move',
    onPress: () => go(state, direction),
  });
  const before = seriesPrevious.status === 'ready' ? peek(seriesPrevious, 'previous') : undefined;
  return {
    nextPart: seriesNext.status === 'ready' ? peek(seriesNext) : undefined,
    related: related.status === 'ready' ? peek(related) : undefined,
    previousPart: before?.onPress,
    previous: before,
  };
}
