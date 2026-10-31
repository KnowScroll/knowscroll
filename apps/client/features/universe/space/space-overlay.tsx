import { memo, useMemo } from 'react';
import type { SceneDescriptor } from '@knowscroll/scene-core';
import { BodyTarget, LABEL_HEIGHT, labelWidth, MapLabel, SceneLayer } from '../scene-parts';
import { isQuiet, placeLabels, type LabelRequest, type Size, type UniverseIndex } from '../universe-layout';
import { CROWDED_TARGET, separateTargets } from './separate-targets';
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

/**
 * A station's name with its count beside it ("Space room · 6 of 7"); any other body is its name. The count is the first part of
 * the caption: the constellation's name stays in the spoken name and the lists, so a label stays short enough to find room.
 */
const captioned = (anchor: SpaceAnchor): string =>
  anchor.caption === undefined ? anchor.name : `${anchor.name} · ${anchor.caption.split(' · ')[0]}`;

/** The size of the tap target of a body: the body's own size on screen, never smaller than a finger. */
const targetSize = (anchor: SpaceAnchor, extra = 0): number => Math.min(160, Math.max(48, anchor.radiusPx * 2 + extra));

/** The side a target would like, before crowding: a finger for most bodies, the body's own size for a big one. */
function sizeOf(anchor: SpaceAnchor): number {
  if (anchor.kind === 'station') return 48;
  if (anchor.kind === 'dust') return targetSize(anchor, 24);
  return anchor.kind === 'system' ? Math.max(56, targetSize(anchor, 16)) : targetSize(anchor, 8);
}

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
        width: labelWidth(captioned(anchor)),
        height: LABEL_HEIGHT,
        priority:
          (anchor.id === selectedId ? 6 : 0) +
          (anchor.id === lastPlaceId ? 3 : 0) +
          (anchor.kind === 'station' ? 0 : 1),
      }));
    return placeLabels(requests, size);
  }, [shown, far, size, selectedId, lastPlaceId]);
  const placed = new Map(labels.map((label) => [label.id, label]));
  // Bodies pass close by each other: keep their tap targets from covering one another.
  const boxes = useMemo(
    () =>
      new Map(
        separateTargets(shown.map((anchor) => ({ id: anchor.id, x: anchor.x, y: anchor.y, size: sizeOf(anchor) }))).map(
          (box) => [box.id, box],
        ),
      ),
    [shown],
  );

  return (
    <SceneLayer>
      {shown.map((anchor) => {
        const label = placed.get(anchor.id);
        const descriptor = index.byId.get(anchor.id);
        const calm = lately && descriptor !== undefined && isQuiet(descriptor);
        return label === undefined ? null : (
          <MapLabel key={`label-${anchor.id}`} label={label} text={captioned(anchor)} calm={calm} />
        );
      })}
      {shown.map((anchor) => {
        const box = boxes.get(anchor.id);
        if (box === undefined) return null;
        const at = { x: box.x, y: box.y, size: box.size, floor: CROWDED_TARGET };
        if (anchor.kind === 'dust')
          return (
            <BodyTarget
              key={anchor.id}
              testID="universe-dust"
              {...at}
              label="Recent reading is gathering here"
              onPress={props.onDust}
            />
          );
        if (anchor.kind === 'station')
          return (
            <BodyTarget
              key={anchor.id}
              testID={`universe-station-${anchor.id}`}
              {...at}
              label={`${anchor.name}, a room station${anchor.caption === undefined ? '' : `, ${anchor.caption}`}`}
              onPress={() => props.onStation(anchor.id)}
            />
          );
        const descriptor = index.byId.get(anchor.id);
        if (descriptor === undefined) return null;
        return (
          <BodyTarget
            key={anchor.id}
            testID={`universe-focus-${anchor.id}`}
            {...at}
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
