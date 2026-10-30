import type { ExposureContextResponse } from '@knowscroll/contracts';
import type { NextPartPeek } from '@knowscroll/ui';
import { continuationLabel, type ReadyContinuation } from './continuation-intent';

/** The moves a v2 Scroll's reader offers from what the server admitted for it (D-134, D-184). */
export interface ReaderContinuations {
  readonly nextPart?: NextPartPeek | undefined;
  readonly related?: NextPartPeek | undefined;
  readonly previousPart?: (() => void) | undefined;
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
  const peek = (state: ReadyContinuation): NextPartPeek => ({
    label: continuationLabel(state),
    title: state.metadata.title,
    related: state.relation.kind === 'related_move',
    onPress: () => go(state, 'next'),
  });
  const { seriesNext, seriesPrevious, related } = continuations;
  return {
    nextPart: seriesNext.status === 'ready' ? peek(seriesNext) : undefined,
    related: related.status === 'ready' ? peek(related) : undefined,
    previousPart: seriesPrevious.status === 'ready' ? () => go(seriesPrevious, 'previous') : undefined,
  };
}
