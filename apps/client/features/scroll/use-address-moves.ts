import { useRouter } from 'expo-router';
import type { AccountScope } from '@knowscroll/client-core';
import { readerContinuations, type ReaderContinuations } from '../encounter/continuation-moves';
import { useOpenedContext } from '../encounter/use-format-siblings';

/**
 * The Part each Scroll was just stepped forward from, by the Scroll's id. It lives in memory only and is taken once, by
 * the reader that opens: a link, a reload or a later visit has no step behind it, so none of them says a place was kept.
 */
const partLeft = new Map<string, number>();

/** The number of the Part a step forward just left for this Scroll, once; `undefined` when it was not opened by one. */
export function takePartLeft(assetId: string): number | undefined {
  const left = partLeft.get(assetId);
  partLeft.delete(assetId);
  return left;
}

/** The moves of a Scroll opened by its address, and the Part it says it is ("Part 1 of 3"). */
export interface AddressMoves extends ReaderContinuations {
  readonly partLabel: string | undefined;
  /** The Part number the context counts, for saying which Part a step forward opened. */
  readonly part?: number | undefined;
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
    if (direction === 'next' && series !== undefined) partLeft.set(state.target.assetId, series.part);
    router.push(`/${state.metadata.kind}/${state.target.assetId}`);
  });
  return {
    ...moves,
    partLabel: series === undefined ? undefined : `Part ${String(series.part)} of ${String(series.total)}`,
    part: series?.part,
  };
}
