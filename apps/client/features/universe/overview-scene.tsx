import { useMemo } from 'react';
import Svg, { Circle } from 'react-native-svg';
import { content, space } from '@knowscroll/design-tokens';
import type { SceneDescriptor } from '@knowscroll/scene-core';
import { BODY_COLOURS, calmColours } from './universe-palette';
import { DustGlyph, OrbitRing, PlanetGlyph, ShipGlyph, StarGlyph } from './universe-bodies';
import {
  composeSystem,
  isQuiet,
  overviewScale,
  placeDust,
  placeLabels,
  SYSTEM_CLUSTER_WORLD,
  worldBounds,
  ORBIT_BANDS,
  outerOrbit,
  type OrbitBand,
  PLANET_RADIUS,
  STAR_RADIUS,
  type LabelRequest,
  type Vec,
} from './universe-layout';
import { BodyTarget, labelWidth, LABEL_HEIGHT, MapLabel, SceneLayer, type SceneProps } from './scene-parts';

/** How much of a system the overview draws, from its size on screen (U08 label levels). */
export type DetailLevel = 'far' | 'mid' | 'near';

/** Pixels per composition unit of a system cluster; one world unit is `scale` pixels. */
export const clusterUnit = (scale: number) => Math.min(scale * (SYSTEM_CLUSTER_WORLD / ORBIT_BANDS[2].rx), 0.72);
export const detailLevel = (unit: number): DetailLevel => (unit < 0.2 ? 'far' : unit < 0.45 ? 'mid' : 'near');

/**
 * U01 and U08: every system as a star with its orbits and planets, at a level of detail that follows
 * its size on screen. Far away only names remain; the same targets exist at every level.
 */
export function OverviewScene({ session, state, index, size, onDust }: SceneProps) {
  const { systems } = index;
  const bounds = useMemo(() => worldBounds(systems), [systems]);
  const scale = overviewScale(systems, size) * state.frame.scale;
  const unit = clusterUnit(scale);
  const level = detailLevel(unit);
  const toScreen = (point: Vec): Vec => ({
    x: size.width / 2 + (point.x - bounds.center.x) * scale - state.frame.x,
    y: size.height * 0.47 + (point.y - bounds.center.y) * scale - state.frame.y,
  });
  const onScreen = (point: Vec) =>
    point.x > -140 && point.x < size.width + 140 && point.y > -140 && point.y < size.height + 140;
  const placed = systems
    .map((system) => ({ system, position: toScreen(system.anchor), composition: composeSystem(index, system) }))
    .filter(({ position }) => onScreen(position));
  const dust = useMemo(
    () =>
      placeDust(
        state.dust.cues.map((cue) => cue.id),
        systems,
      ),
    [state.dust.cues, systems],
  );
  const lone = state.dust.cues.length === 1 && systems.length === 0;
  const lastSystemId = state.lastPlace ? lastSystemIdOf(index, state.lastPlace.id) : undefined;

  const outerRy = (bands: readonly OrbitBand[]) => outerOrbit(bands).ry * unit;
  const requests: LabelRequest[] = placed.map(({ system, position, composition }) => {
    const text = system.label;
    return {
      id: system.objectId,
      anchor: position,
      clearance: level === 'far' ? 14 : outerRy(composition.bands) + 12,
      width: labelWidth(text),
      height: LABEL_HEIGHT,
      priority:
        (system.objectId === state.selectedId ? 6 : 0) +
        (system.objectId === lastSystemId ? 3 : 0) +
        (state.lately && !isQuiet(system) ? 2 : 0) +
        (isQuiet(system) ? 0 : 1),
    };
  });
  const labels = placeLabels(requests, size);
  const ship = lastSystemId ? placed.find(({ system }) => system.objectId === lastSystemId) : undefined;

  const press = (system: SceneDescriptor) => {
    // Far away a first tap picks the system and shows its card; closer in, a tap flies there.
    if (level === 'far' && state.selectedId !== system.objectId) session.select(system.objectId);
    else session.focus(system.objectId);
  };

  return (
    <>
      <Svg width={size.width} height={size.height} pointerEvents="none" aria-hidden>
        {[...dust].map(([id, world]) => {
          const at = toScreen(world);
          return onScreen(at) ? (
            <DustGlyph key={id} id={id} cx={at.x} cy={at.y} r={lone ? 74 : 30} lone={lone} />
          ) : null;
        })}
        {placed.map(({ system, position, composition }) => {
          const calm = state.lately && isQuiet(system);
          return (
            <ClusterDrawing
              key={system.objectId}
              session={session}
              position={position}
              composition={composition}
              unit={unit}
              level={level}
              calm={calm}
              lately={state.lately}
              selected={state.selectedId === system.objectId}
            />
          );
        })}
        {ship ? (
          <ShipGlyph
            x={ship.position.x + 22 + ORBIT_BANDS[0].rx * unit * 0.2}
            y={ship.position.y - outerRy(ship.composition.bands) - 14}
          />
        ) : null}
      </Svg>
      <SceneLayer>
        {labels.map((label) => {
          const system = systems.find((candidate) => candidate.objectId === label.id)!;
          return <MapLabel key={label.id} label={label} text={system.label} calm={state.lately && isQuiet(system)} />;
        })}
        {[...dust].map(([id, world]) => {
          const at = toScreen(world);
          return onScreen(at) ? (
            <BodyTarget
              key={id}
              testID="universe-dust"
              x={at.x}
              y={at.y}
              size={lone ? 148 : 60}
              label="Recent reading is gathering here"
              onPress={() => onDust?.()}
            />
          ) : null;
        })}
        {placed.map(({ system, position, composition }) => (
          <BodyTarget
            key={system.objectId}
            testID={`universe-focus-${system.objectId}`}
            x={position.x}
            y={position.y}
            size={Math.min(160, Math.max(48, outerOrbit(composition.bands).rx * unit * 1.1))}
            label={system.label}
            kind="system"
            hypothetical={system.truthStatus === 'hypothetical'}
            selected={state.selectedId === system.objectId}
            onPress={() => press(system)}
          />
        ))}
      </SceneLayer>
    </>
  );
}

function lastSystemIdOf(index: SceneProps['index'], placeId: string): string | undefined {
  let place = index.byId.get(placeId);
  for (let hops = 0; place && hops < 4; hops++) {
    if (place.kind === 'system') return place.objectId;
    place = index.byId.get(place.parentId);
  }
  return undefined;
}

function ClusterDrawing({
  session,
  position,
  composition,
  unit,
  level,
  calm,
  lately,
  selected,
}: {
  readonly session: SceneProps['session'];
  readonly position: Vec;
  readonly composition: ReturnType<typeof composeSystem>;
  readonly unit: number;
  readonly level: DetailLevel;
  readonly calm: boolean;
  readonly lately: boolean;
  readonly selected: boolean;
}) {
  const starRadius = level === 'far' ? 5 : STAR_RADIUS * unit;
  return (
    <>
      {selected ? (
        <Circle
          cx={position.x}
          cy={position.y}
          r={Math.max(26, 90 * unit)}
          fill="none"
          stroke={space.focus}
          strokeWidth={2}
        />
      ) : null}
      {level === 'far'
        ? null
        : composition.bands.map((band) => (
            <OrbitRing
              key={band}
              cx={position.x}
              cy={position.y}
              rx={ORBIT_BANDS[band].rx * unit}
              ry={ORBIT_BANDS[band].ry * unit}
              calm={calm}
            />
          ))}
      <StarGlyph cx={position.x} cy={position.y} r={Math.max(4, starRadius)} calm={calm} />
      {level === 'far'
        ? null
        : composition.planets.map(({ descriptor, position: offset }) => {
            const at = { x: position.x + offset.x * unit, y: position.y + offset.y * unit };
            const planetCalm = lately && isQuiet(descriptor);
            const geometry = level === 'near' ? session.geometry(descriptor) : undefined;
            return geometry ? (
              <PlanetGlyph
                key={descriptor.objectId}
                cx={at.x}
                cy={at.y}
                r={Math.max(6, PLANET_RADIUS * unit)}
                geometry={geometry}
                seed={descriptor.seed}
                calm={planetCalm}
                low
              />
            ) : (
              <Circle
                key={descriptor.objectId}
                cx={at.x}
                cy={at.y}
                r={Math.max(2.5, 8 * unit)}
                fill={
                  (planetCalm ? calmColours(BODY_COLOURS[descriptor.palette]) : BODY_COLOURS[descriptor.palette])
                    .oceanMid
                }
                stroke={content.paper}
                strokeOpacity={0.3}
              />
            );
          })}
    </>
  );
}
