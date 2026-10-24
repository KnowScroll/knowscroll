import Svg, { Path } from 'react-native-svg';
import { space } from '@knowscroll/design-tokens';
import type { SceneDescriptor } from '@knowscroll/scene-core';
import { OrbitRing, PlanetGlyph, ShipGlyph, StarGlyph } from './universe-bodies';
import {
  composeSystem,
  isQuiet,
  placeLabels,
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
  type SceneProps,
} from './scene-parts';

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
        {parked ? (
          <ShipGlyph x={at(parked.position).x + planetRadius + 18} y={at(parked.position).y - planetRadius - 6} />
        ) : null}
      </Svg>
      <SceneLayer>
        {labels.map((label) => {
          const planet = composition.planets.find((p) => p.descriptor.objectId === label.id)!.descriptor;
          return <MapLabel key={label.id} label={label} text={planet.label} calm={state.lately && isQuiet(planet)} />;
        })}
        {composition.routes.map((route) => {
          const from = at(route.from),
            to = at(route.to);
          const middle = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 + 14 * unit };
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
