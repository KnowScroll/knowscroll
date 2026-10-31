import { useCallback, useEffect, useMemo } from 'react';
import type { SceneLook } from '@knowscroll/scene-core';
import type { SceneProps } from '../scene-parts';
import type { UniverseView } from '../universe-layout';
import type { RigFocus } from './camera-rig';
import { layOutUniverse, looksById } from './space-model';
import { SpaceOverlay } from './space-overlay';
import type { SpaceCameraSpec } from './space-renderer';
import type { SpaceChoice, SpaceFailure } from './space-surface';
import { SpaceView, type SpaceOverlayInfo } from './space-view';

const looksOfRead = (state: SceneProps['state']): readonly SceneLook[] | undefined => state.read.snapshot?.read.looks;

/**
 * U01, U08 and U02 in 3D: the whole universe (the Overview, and Far when the camera has drawn back) or
 * one system with its planets, drawn by three.js with labels and tap targets laid over it. A planet's
 * own close-up is the SVG scene, not this one. When 3D is not available it tells the screen
 * (`onUnavailable`), which turns the whole tab into the Simple lists, so every place stays reachable
 * (D-111).
 */
export function SpaceStage({
  session,
  state,
  index,
  size,
  view,
  onDust,
  stations,
  onStation,
  onUnavailable,
  pickPlanets = false,
}: SceneProps & {
  readonly view: Extract<UniverseView, { kind: 'universe' | 'system' }>;
  /** 3D cannot be drawn, and why: WebGL missing, a lost context, a failed frame or low memory. */
  readonly onUnavailable: (reason: SpaceFailure) => void;
  /** A tap on a planet picks it for the panel's card (Land, Close) instead of flying to it (D02). */
  readonly pickPlanets?: boolean;
}) {
  const looks = looksOfRead(state);
  const space = useMemo(
    () =>
      layOutUniverse({
        index,
        looks: looksById(looks),
        stations: stations ?? [],
        dustCueIds: state.dust.cues.map((cue) => cue.id),
        lately: state.lately,
        lastPlaceId: state.lastPlace?.id,
      }),
    [index, looks, stations, state.dust.cues, state.lately, state.lastPlace?.id],
  );
  const systemId = view.kind === 'system' ? view.system.objectId : undefined;
  const focus: RigFocus = useMemo(
    () => (systemId === undefined ? undefined : space.systemFocus(systemId)) ?? space.universeFocus,
    [space, systemId],
  );
  const frame = state.frame;
  const camera: SpaceCameraSpec = useMemo(() => ({ focus, frame }), [focus, frame]);

  const overlay = useCallback(
    ({ anchors, far }: SpaceOverlayInfo) => (
      <SpaceOverlay
        anchors={anchors}
        far={far}
        index={index}
        size={size}
        {...(focus.kind === 'system' ? { systemId: focus.systemId } : {})}
        selectedId={state.selectedId}
        lately={state.lately}
        lastPlaceId={state.lastPlace?.id}
        // Far away a first tap picks the system and shows its card; closer in, a tap flies there.
        onSystem={(system) => {
          if (far && state.selectedId !== system.objectId) session.select(system.objectId);
          else session.focus(system.objectId);
        }}
        onPlanet={(planet) => {
          if (pickPlanets) session.select(planet.objectId);
          else void session.focus(planet.objectId);
        }}
        onStation={(roomId) => onStation?.(roomId)}
        onDust={() => onDust?.()}
      />
    ),
    [index, size, focus, state.selectedId, state.lately, state.lastPlace?.id, session, onStation, onDust, pickPlanets],
  );

  const choose = useCallback(
    (choice: SpaceChoice) => {
      if (choice.kind === 'station') onStation?.(choice.id);
      else void session.focus(choice.id);
    },
    [session, onStation],
  );
  return (
    <SpaceView
      definition={space.definition}
      camera={camera}
      highlightId={state.selectedId}
      overlay={overlay}
      fallback={(reason) => <Unavailable reason={reason} onUnavailable={onUnavailable} />}
      onChoose={choose}
    />
  );
}

/** Draws nothing: it tells the screen 3D is gone, and the screen swaps in the Simple lists. */
function Unavailable({
  reason,
  onUnavailable,
}: {
  readonly reason: SpaceFailure;
  readonly onUnavailable: (reason: SpaceFailure) => void;
}) {
  useEffect(() => onUnavailable(reason), [reason, onUnavailable]);
  return null;
}
