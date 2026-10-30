import type { ScrollResults } from '@knowscroll/contracts';
import type { StoredPlay } from './ports.js';

/** What the reader is shown of one revision: the calls in the order locked, the sparks and the combo. */
export function resultsOf(
  revision: { readonly assetId: string; readonly revision: number },
  play: StoredPlay,
): ScrollResults {
  return {
    assetId: revision.assetId,
    revision: revision.revision,
    calls: play.calls.map((call) => ({ stopId: call.stopId, option: call.option, correct: call.correct })),
    sparks: play.tally.sparks,
    combo: play.tally.combo,
  };
}
