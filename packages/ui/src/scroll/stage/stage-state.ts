import type { Stage, Stop } from '@knowscroll/scroll-model';

/** One entry of a document's stage: the stop that changes the picture, the state it changes it to, and its words. */
export type StageEntry = Stage['states'][number];

/**
 * The stage state that holds at a stop: the last one set at or before it (every other stop keeps the
 * state before it). The document guarantees a state on the first stop, so there is always one; an
 * unknown stop id gets the first. Pure.
 */
export function stageEntryAt(stage: Stage, stops: readonly Pick<Stop, 'id'>[], stopId: string): StageEntry {
  const position = new Map(stops.map((stop, index) => [stop.id, index]));
  const at = position.get(stopId) ?? 0;
  let held = stage.states[0];
  for (const entry of stage.states) {
    if ((position.get(entry.stop) ?? Infinity) <= at) held = entry;
  }
  if (held === undefined) throw new Error('A stage has at least one state');
  return held;
}
