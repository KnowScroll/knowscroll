import { memo, useMemo } from 'react';
import type { SceneDescriptor } from '@knowscroll/scene-core';
import { BodyTarget, LABEL_HEIGHT, labelWidth, MapLabel, SceneLayer } from '../scene-parts';
import { isQuiet, placeLabels, type LabelRequest, type Size, type UniverseIndex } from '../universe-layout';
import type { SpaceOverlayInfo } from './space-view';
import type { SpaceAnchor } from './space-surface';

/** What the overlay can do with a tap, and what it needs to know about the screen. */
export interface SpaceOverlayProps extends SpaceOverlayInfo {
  readonly index: UniverseIndex;
  readonly size: Size;
  /** The system a System view is of; absent for the whole universe. */
  readonly systemId?: string;
  readonly selectedId: string | null;
  readonly lately: boolean;
  /** The place the ship is parked at, whose label is lifted so it is never lost. */
  readonly lastPlaceId: string | undefined;
  readonly onSystem: (system: SceneDescriptor) => void;
  readonly onPlanet: (planet: SceneDescriptor) => void;
  readonly onStation: (roomId: string) => void;
  readonly onDust: () => void;
}

/** The size of the tap target of a body: the body's own size on screen, never smaller than a finger. */
const targetSize = (anchor: SpaceAnchor, extra = 0): number => Math.min(160, Math.max(48, anchor.radiusPx * 2 + extra));

/** Whether an anchor is something this view lets a person reach. */
function reachable(anchor: SpaceAnchor, systemId: string | undefined, far: boolean): boolean {
  if (!anchor.visible) return false;
  if (systemId === undefined)
    // The whole universe: suns, the stations beside them and dust. Planets are reached by entering a system.
    return anchor.kind === 'system' || anchor.kind === 'dust' || (anchor.kind === 'station' && !far);
  return anchor.systemId === systemId && (anchor.kind === 'planet' || anchor.kind === 'station');
}

/**
 * The labels and tap targets over a space view. They are ordinary views placed at the projected
 * points of the scene, so a screen reader, the keyboard and a finger reach places exactly as they
 * did before the picture was 3D; the canvas beneath is decoration. Targets keep a stable order (the
 * scene's own), so keyboard focus does not jump as bodies move.
 */
export const SpaceOverlay = memo(function SpaceOverlay(props: SpaceOverlayProps) {
  const { anchors, far, index, size, systemId, selectedId, lately, lastPlaceId } = props;
  const shown = useMemo(() => anchors.filter((anchor) => reachable(anchor, systemId, far)), [anchors, systemId, far]);
  const labels = useMemo(() => {
    const requests: LabelRequest[] = shown
      .filter((anchor) => anchor.kind !== 'dust' && !(anchor.kind === 'station' && far))
      .map((anchor) => ({
        id: anchor.id,
        anchor: { x: anchor.x, y: anchor.y },
        clearance: anchor.kind === 'system' ? Math.max(anchor.radiusPx, 6) + (far ? 14 : 22) : anchor.radiusPx + 10,
        width: labelWidth(anchor.name),
        height: LABEL_HEIGHT,
        priority:
          (anchor.id === selectedId ? 6 : 0) +
          (anchor.id === lastPlaceId ? 3 : 0) +
          (anchor.kind === 'station' ? 0 : 1),
      }));
    return placeLabels(requests, size);
  }, [shown, far, size, selectedId, lastPlaceId]);
  const placed = new Map(labels.map((label) => [label.id, label]));

  return (
    <SceneLayer>
      {shown.map((anchor) => {
        const label = placed.get(anchor.id);
        const descriptor = index.byId.get(anchor.id);
        const calm = lately && descriptor !== undefined && isQuiet(descriptor);
        return label === undefined ? null : (
          <MapLabel key={`label-${anchor.id}`} label={label} text={anchor.name} calm={calm} />
        );
      })}
      {shown.map((anchor) => {
        if (anchor.kind === 'dust')
          return (
            <BodyTarget
              key={anchor.id}
              testID="universe-dust"
              x={anchor.x}
              y={anchor.y}
              size={targetSize(anchor, 24)}
              label="Recent reading is gathering here"
              onPress={props.onDust}
            />
          );
        if (anchor.kind === 'station')
          return (
            <BodyTarget
              key={anchor.id}
              testID={`universe-station-${anchor.id}`}
              x={anchor.x}
              y={anchor.y}
              size={48}
              label={`${anchor.name}, a room station`}
              onPress={() => props.onStation(anchor.id)}
            />
          );
        const descriptor = index.byId.get(anchor.id);
        if (descriptor === undefined) return null;
        return (
          <BodyTarget
            key={anchor.id}
            testID={`universe-focus-${anchor.id}`}
            x={anchor.x}
            y={anchor.y}
            size={anchor.kind === 'system' ? Math.max(56, targetSize(anchor, 16)) : targetSize(anchor, 8)}
            label={anchor.name}
            kind={anchor.kind}
            hypothetical={descriptor.truthStatus === 'hypothetical'}
            selected={selectedId === anchor.id}
            onPress={() => (anchor.kind === 'system' ? props.onSystem(descriptor) : props.onPlanet(descriptor))}
          />
        );
      })}
    </SceneLayer>
  );
});
