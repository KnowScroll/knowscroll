import type { Stage, Stop } from '@knowscroll/scroll-model';
import { isKitPictureId, KIT_PICTURES, type KitPictureId } from '../kit';
import type { FigureState } from './kit-figure';
import { stageEntryAt } from './stage-state';

/** A stage of a kit this build draws. */
export type DrawableStage = Stage & { readonly kit: KitPictureId };

/**
 * The stage when this build can draw its kit, otherwise nothing. A stored stage may name a kit that has been removed
 * since (its revision stays readable), and there is no picture to make of one: the Scroll reads as text. Every reader
 * of a stage goes through this before it looks the kit up.
 */
export function drawableStage(stage: Stage | undefined): DrawableStage | undefined {
  return stage !== undefined && isKitPictureId(stage.kit) ? (stage as DrawableStage) : undefined;
}

/**
 * The figure a `scroll-document.v2` stage shows at a stop: the state that holds there, named by the stop that set it.
 * With `recap`, the picture of the whole journey instead, when the kit can draw one honestly for these states (Earth &
 * sky needs two months on its orbit); otherwise the state at the stop. Pure.
 */
export function stageFigureAt(
  stage: DrawableStage,
  stops: readonly Pick<Stop, 'id'>[],
  stopId: string,
  recap = false,
): FigureState {
  const entry = stageEntryAt(stage, stops, stopId);
  const drawsRecap = KIT_PICTURES[stage.kit].recap;
  const states = stage.states.map((held) => held.state);
  if (recap && drawsRecap !== undefined && drawsRecap.sceneOf(states) !== undefined) {
    return { kind: 'recap', kit: stage.kit, states, alt: drawsRecap.describe(states) ?? entry.alt, key: 'recap' };
  }
  return { kind: 'state', kit: stage.kit, state: entry.state, alt: entry.alt, key: entry.stop };
}
