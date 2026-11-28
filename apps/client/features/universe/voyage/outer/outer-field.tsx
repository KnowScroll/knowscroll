import { useSyncExternalStore } from 'react';
import type { UniverseOnScreen } from '../voyage-control';
import type { Disc, Point, Viewport } from './friend-field';
import type { OuterFriend } from './friend-order';
import type { OuterStatus } from './outer-copy';
import { OuterLayer } from './outer-layer';

/** What the field reads of the camera's controller: where the universe is on screen, told only when it visibly moved. */
export interface UniverseSource {
  readonly universe: () => UniverseOnScreen | null;
  readonly subscribe: (listener: () => void) => () => void;
  /** Told where the bubbles are, so the parked ship keeps off them. */
  readonly setObstacles: (circles: readonly Disc[]) => void;
}

/** The friends' buttons come in once the field is this much in, so a pinch half made never starts a film. */
const BUTTONS_FROM_FADE = 0.6;
const NO_PAN: Point = { x: 0, y: 0 };

/**
 * The outer layer as the Universe's stage mounts it: it follows where the camera says the universe is (which already
 * carries the field's pan, so the layer is given none) and re-renders only when that visibly changes, never once a frame.
 * It is mounted by the stage whenever the screen has an outer stop and it is not a friend's Universe; it draws nothing
 * until the field has any of the universe in it. The screen's header says the title and the line.
 */
export function OuterField({
  source,
  friends,
  status,
  onRetry,
  onCross,
  atStop,
  viewport,
  reducedMotion,
}: {
  readonly source: UniverseSource;
  readonly friends: readonly OuterFriend[];
  readonly status: OuterStatus;
  readonly onRetry: () => void;
  readonly onCross: (handle: string) => void;
  /** The camera is at the outer stop (or going there), not only passing through the field's fade. */
  readonly atStop: boolean;
  readonly viewport: Viewport;
  readonly reducedMotion: boolean;
}) {
  const universe = useSyncExternalStore(source.subscribe, source.universe, source.universe);
  if (universe === null) return null;
  return (
    <OuterLayer
      universe={universe}
      pan={NO_PAN}
      friends={friends}
      viewport={viewport}
      buttonsLive={atStop && universe.fade >= BUTTONS_FROM_FADE}
      reducedMotion={reducedMotion}
      onCross={onCross}
      status={status}
      onRetry={onRetry}
      onBubbles={source.setObstacles}
      words={false}
    />
  );
}
