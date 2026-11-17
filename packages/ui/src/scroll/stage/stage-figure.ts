import type { Stage, Stop } from '@knowscroll/scroll-model';
import { KIT_PICTURES } from '../kit';
import type { FigureState } from './kit-figure';
import { stageEntryAt } from './stage-state';

/**
 * The figure a `scroll-document.v2` stage shows at a stop: the state that holds there, named by the stop that set it.
 * With `recap`, the picture of the whole journey instead, when the kit can draw one honestly; a kit that cannot keeps
 * the state at the stop. Pure.
 */
export function stageFigureAt(
  stage: Stage,
  stops: readonly Pick<Stop, 'id'>[],
  stopId: string,
  recap = false,
): FigureState {
  const entry = stageEntryAt(stage, stops, stopId);
  const drawsRecap = KIT_PICTURES[stage.kit].recap;
  if (recap && drawsRecap !== undefined) {
    const states = stage.states.map((held) => held.state);
    return { kind: 'recap', kit: stage.kit, states, alt: drawsRecap.describe(states) ?? entry.alt, key: 'recap' };
  }
  return { kind: 'state', kit: stage.kit, state: entry.state, alt: entry.alt, key: entry.stop };
}
