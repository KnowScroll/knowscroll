import Svg, { Path } from 'react-native-svg';
import { space, target } from '@knowscroll/design-tokens';
import type { SceneDescriptor } from '@knowscroll/scene-core';
import { OrbitRing, PlanetGlyph, ShipGlyph, StarGlyph, StationGlyph } from './universe-bodies';
import {
  composeSystem,
  isQuiet,
  placeLabels,
  stationOffset,
  ORBIT_BANDS,
  PLANET_RADIUS,
  STAR_RADIUS,
  type LabelRequest,
} from './universe-layout';
import {
  BodyTarget,
  safeGeometry,
  labelWidth,
  LABEL_HEIGHT,
  MapLabel,
  SceneLayer,
  stationName,
  type SceneProps,
} from './scene-parts';

interface Point {
  readonly x: number;
  readonly y: number;
}

/** Room kept between a route's target and a planet's target (WCAG 2.5.8: targets that overlap need space). */
const TARGET_GAP = 12;

/**
 * Where a route's tap target sits: on the middle of its curve, unless that is under a planet's own
 * target (planets close together), when it drops just below them. The list view lists the same routes.
 */
function routeTargetAt(middle: Point, planets: readonly Point[], planetSide: number): Point {
  const reach = planetSide / 2 + target.comfortable / 2 + TARGET_GAP;
  const crowded = planets.some(
    (planet) => Math.abs(planet.x - middle.x) < reach && Math.abs(planet.y - middle.y) < reach,
  );
  if (!crowded) return middle;
  const lowest = Math.max(...planets.map((planet) => planet.y));
  return { x: middle.x, y: Math.max(middle.y, lowest + reach) };
}

/**
 * U02: one system, organised by its star. Planets sit on orbits in the direction their persisted
 * anchors have from the star; a dashed line joins planets the Cartographer routed together.
 */
export function SystemScene({
  session,
  state,
  index,
  size,
  system,
  stations,
  onStation,
}: SceneProps & { readonly system: SceneDescriptor }) {
  const composition = composeSystem(index, system);
  const unit =
    Math.min((size.width * 0.5) / composition.extent.width, (size.height * 0.24) / composition.extent.height, 1.5) *
    state.frame.scale;
  const centre = { x: size.width / 2 - state.frame.x, y: size.height * 0.5 - state.frame.y };
  const at = (point: { x: number; y: number }) => ({ x: centre.x + point.x * unit, y: centre.y + point.y * unit });
  const planetRadius = PLANET_RADIUS * unit;
  const requests: LabelRequest[] = composition.planets.map(({ descriptor }) => ({
    id: descriptor.objectId,
    anchor: at(composition.planets.find((p) => p.descriptor.objectId === descriptor.objectId)!.position),
    clearance: planetRadius + 6,
    width: labelWidth(descriptor.label),
    height: LABEL_HEIGHT,
    priority: descriptor.objectId === state.lastPlace?.id ? 2 : 1,
  }));
  // The stations of rooms whose topic is this system, or one of its planets: beside that planet, else below the orbits.
  // The stage is small on a phone, so a station is kept inside it, clear of the header and the chips.
  const inView = (point: { x: number; y: number }) => ({
    x: Math.min(size.width - 52, Math.max(52, point.x)),
    y: Math.min(size.height - 170, Math.max(150, point.y)),
  });
  const here = (stations ?? [])
    .filter((station) => station.placement.systemId === system.objectId)
    .map((station) => {
      const planet =
        station.placement.planetId === undefined
          ? undefined
          : composition.planets.find(({ descriptor }) => descriptor.objectId === station.placement.planetId);
      if (planet) {
        const point = at(planet.position);
        return { station, at: inView({ x: point.x + planetRadius + 26, y: point.y + planetRadius + 14 }) };
      }
      const offset = stationOffset(station.room.roomId, composition.bands, unit, 38);
      return { station, at: inView({ x: centre.x + offset.x, y: centre.y + offset.y }) };
    });
  for (const { station, at: spot } of here)
    requests.push({
      id: `station:${station.room.roomId}`,
      anchor: spot,
      clearance: 30,
      width: labelWidth(station.room.name),
      height: LABEL_HEIGHT,
      priority: 0,
    });
  const labels = placeLabels(requests, size);
  const parked = composition.planets.find(({ descriptor }) => descriptor.objectId === state.lastPlace?.id);
  return (
    <>
      <Svg width={size.width} height={size.height} pointerEvents="none" aria-hidden>
        {composition.bands.map((band) => (
          <OrbitRing
            key={band}
            cx={centre.x}
            cy={centre.y}
            rx={ORBIT_BANDS[band].rx * unit}
            ry={ORBIT_BANDS[band].ry * unit}
          />
        ))}
        {composition.routes.map((route) => {
          const from = at(route.from),
            to = at(route.to);
          const bend = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 + 28 * unit };
          return (
            <Path
              key={route.id}
              d={`M ${from.x} ${from.y} Q ${bend.x} ${bend.y} ${to.x} ${to.y}`}
              fill="none"
              stroke={space.route}
              strokeWidth={1.4}
              strokeDasharray="2 6"
              strokeLinecap="round"
            />
          );
        })}
        <StarGlyph cx={centre.x} cy={centre.y} r={STAR_RADIUS * unit} calm={state.lately && isQuiet(system)} />
        {composition.planets.map(({ descriptor, position }) => {
          const geometry = safeGeometry(session, descriptor);
          const point = at(position);
          return geometry ? (
            <PlanetGlyph
              key={descriptor.objectId}
              cx={point.x}
              cy={point.y}
              r={planetRadius}
              geometry={geometry}
              seed={descriptor.seed}
              calm={state.lately && isQuiet(descriptor)}
              low={state.detail === 'low'}
            />
          ) : null;
        })}
        {here.map(({ station, at: spot }) => (
          <StationGlyph key={station.room.roomId} x={spot.x} y={spot.y} scale={0.85} calm={state.lately} />
        ))}
        {parked ? (
          <ShipGlyph x={at(parked.position).x + planetRadius + 18} y={at(parked.position).y - planetRadius - 6} />
        ) : null}
      </Svg>
      <SceneLayer>
        {labels.map((label) => {
          const planet = composition.planets.find((p) => p.descriptor.objectId === label.id)?.descriptor;
          if (planet)
            return <MapLabel key={label.id} label={label} text={planet.label} calm={state.lately && isQuiet(planet)} />;
          const station = here.find((entry) => `station:${entry.station.room.roomId}` === label.id);
          return station ? <MapLabel key={label.id} label={label} text={station.station.room.name} /> : null;
        })}
        {composition.routes.map((route) => {
          const from = at(route.from),
            to = at(route.to);
          const middle = routeTargetAt(
            { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 + 14 * unit },
            [from, to],
            Math.max(planetRadius * 2, target.comfortable),
          );
          const named = (id: string) => index.byId.get(id)?.label ?? '';
          return (
            <BodyTarget
              key={route.id}
              testID={`universe-route-${route.id}`}
              x={middle.x}
              y={middle.y}
              label={`Route from ${named(route.fromId)} to ${named(route.toId)}`}
              onPress={() => session.travel(route.id)}
            />
          );
        })}
        {here.map(({ station, at: spot }) => (
          <BodyTarget
            key={station.room.roomId}
            testID={`universe-station-${station.room.roomId}`}
            x={spot.x}
            y={spot.y}
            size={48}
            label={stationName(station)}
            onPress={() => onStation?.(station.room.roomId)}
          />
        ))}
        {composition.planets.map(({ descriptor, position }) => {
          const point = at(position);
          return (
            <BodyTarget
              key={descriptor.objectId}
              testID={`universe-focus-${descriptor.objectId}`}
              x={point.x}
              y={point.y}
              size={planetRadius * 2}
              label={descriptor.label}
              kind="planet"
              hypothetical={descriptor.truthStatus === 'hypothetical'}
              onPress={() => session.focus(descriptor.objectId)}
            />
          );
        })}
      </SceneLayer>
    </>
  );
}
