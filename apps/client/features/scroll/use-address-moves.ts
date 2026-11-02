import { useRouter } from 'expo-router';
import type { AccountScope } from '@knowscroll/client-core';
import { readerContinuations, type ReaderContinuations } from '../encounter/continuation-moves';
import { useOpenedContext } from '../encounter/use-format-siblings';
import { notePartLeft } from './part-left';

/** The moves of a Scroll opened by its address, and the Part it says it is ("Part 1 of 3"). */
export interface AddressMoves extends ReaderContinuations {
  readonly partLabel: string | undefined;
  /** The Part number the context counts, for saying which Part a step forward opened. */
  readonly part?: number | undefined;
  /** The series the context counts the Part in, so a step noted for another series is not taken for this one. */
  readonly seriesId?: string | undefined;
}

/**
 * What the reader can move to from `/scroll/<id>` (D-184). There is no encounter here, so a Part is not a
 * navigation command with a displayed link: it is the address of the Scroll the server admitted as the next
 * (or previous) Part, and opening it makes that Scroll's own exposure like any address does. The context
 * is the same read the format switch makes. Until it arrives, and when it fails, there are no moves: the
 * reader is still a reader, and a button is never drawn for a Part nobody admitted.
 */
export function useAddressMoves(scope: AccountScope, exposureId: string): AddressMoves {
  const router = useRouter();
  const { data } = useOpenedContext(scope, exposureId);
  if (data === undefined) return { partLabel: undefined };
  const { series } = data;
  // A step forward notes which Part it left, so the Part that opens can say its place there is kept.
  const moves = readerContinuations(data.continuations, (state, direction) => {
    // Only a step forward in a series notes it: a related move or another angle leaves no "place kept" to say.
    if (direction === 'next' && series !== undefined && state.relation.kind === 'series_step')
      notePartLeft(scope, state.target.assetId, { part: series.part, seriesId: series.seriesId });
    router.push(`/${state.metadata.kind}/${state.target.assetId}`);
  });
  return {
    ...moves,
    partLabel: series === undefined ? undefined : `Part ${String(series.part)} of ${String(series.total)}`,
    part: series?.part,
    seriesId: series?.seriesId,
  };
}
