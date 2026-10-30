import { useRouter } from 'expo-router';
import type { AccountScope } from '@knowscroll/client-core';
import { readerContinuations, type ReaderContinuations } from '../encounter/continuation-moves';
import { useOpenedContext } from '../encounter/use-format-siblings';

/** The moves of a Scroll opened by its address, and the Part it says it is ("Part 1 of 3"). */
export interface AddressMoves extends ReaderContinuations {
  readonly partLabel: string | undefined;
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
  const moves = readerContinuations(data.continuations, (state) =>
    router.push(`/${state.metadata.kind}/${state.target.assetId}`),
  );
  const { series } = data;
  return {
    ...moves,
    partLabel: series === undefined ? undefined : `Part ${String(series.part)} of ${String(series.total)}`,
  };
}
