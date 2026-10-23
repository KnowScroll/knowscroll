import Svg, { Path, Rect } from 'react-native-svg';
import { content } from '@knowscroll/design-tokens';
import type { SceneDescriptor } from '@knowscroll/scene-core';
import { LandmarkGlyph, PlanetGlyph, RegionPin, ShipGlyph, silhouettePath, type LandmarkKind } from './universe-bodies';
import { BODY_COLOURS } from './universe-palette';
import { composeRegions, isQuiet, placeLabels, unitsFromId, type LabelRequest } from './universe-layout';
import {
  BodyTarget,
  safeGeometry,
  labelWidth,
  MapLabel,
  PILL_HEIGHT,
  SceneLayer,
  type SceneProps,
} from './scene-parts';

/** How far the camera drops toward the land when a region is chosen (U03 "Region focus"). */
const REGION_ZOOM = 2.2;

/**
 * U03 and U04: a planet drawn as a place, with its regions as pins on the land. Choosing a pin
 * lowers the camera over it and opens its card; none of this is a visit to anything.
 */
export function PlanetScene({
  session,
  state,
  index,
  size,
  planet,
  selectedRegion,
}: SceneProps & { readonly planet: SceneDescriptor; readonly selectedRegion: SceneDescriptor | undefined }) {
  const geometry = safeGeometry(session, planet);
  const regions = composeRegions(index, planet);
  if (!geometry) return null;
  const baseRadius = Math.min(size.width * 0.39, size.height * 0.3);
  const zoom = selectedRegion ? REGION_ZOOM : 1;
  const radius = baseRadius * zoom * state.frame.scale;
  const focus = regions.find(({ descriptor }) => descriptor.objectId === selectedRegion?.objectId)?.offset ?? {
    x: 0,
    y: 0,
  };
  const centre = {
    x: size.width / 2 - focus.x * radius - state.frame.x,
    y: size.height * (selectedRegion ? 0.36 : 0.34) - focus.y * radius - state.frame.y,
  };
  const pinAt = (offset: { x: number; y: number }) => ({
    x: centre.x + offset.x * radius,
    y: centre.y + offset.y * radius,
  });
  const pinSize = Math.min(15, 11 + (zoom - 1) * 3);
  const route = [...regions]
    .sort((a, b) => a.offset.x - b.offset.x || a.offset.y - b.offset.y)
    .map(({ offset }) => pinAt(offset));
  // Decoration from the planet's own seed, so the same person sees the same landmark on every device.
  const [kindUnit, regionUnit] = unitsFromId(planet.seed);
  const landmarkKind: LandmarkKind = kindUnit < 0.5 ? 'lighthouse' : 'harbour';
  const landmarkRegion = regions[Math.floor(regionUnit * regions.length) % Math.max(1, regions.length)];
  const parked = regions.find(({ descriptor }) => descriptor.objectId === state.lastPlace?.id);
  const requests: LabelRequest[] = regions.map(({ descriptor, offset }) => ({
    id: descriptor.objectId,
    anchor: pinAt(offset),
    clearance: pinSize + 6,
    width: labelWidth(descriptor.label, 18),
    height: PILL_HEIGHT,
    priority:
      descriptor.objectId === selectedRegion?.objectId ? 3 : descriptor.objectId === state.lastPlace?.id ? 2 : 1,
  }));
  const labels = placeLabels(requests, size);
  return (
    <>
      <Svg width={size.width} height={size.height} pointerEvents="none" aria-hidden>
        <PlanetGlyph
          cx={centre.x}
          cy={centre.y}
          r={radius}
          geometry={geometry}
          seed={planet.seed}
          calm={state.lately && isQuiet(planet)}
          low={state.detail === 'low'}
          terminator={!selectedRegion}
        />
        {route.length > 1 ? (
          <Path
            d={`M ${route.map((point) => `${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' L ')}`}
            fill="none"
            stroke={content.paper}
            strokeWidth={2}
            strokeDasharray="3 5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : null}
        {landmarkRegion ? (
          <LandmarkGlyph
            x={pinAt(landmarkRegion.offset).x + pinSize * 1.7}
            y={pinAt(landmarkRegion.offset).y - pinSize * 1.7}
            kind={landmarkKind}
          />
        ) : null}
        {regions.map(({ descriptor, offset }) => (
          <RegionPin
            key={descriptor.objectId}
            x={pinAt(offset).x}
            y={pinAt(offset).y}
            size={pinSize}
            selected={descriptor.objectId === selectedRegion?.objectId}
          />
        ))}
        {parked ? <ShipGlyph x={pinAt(parked.offset).x + 30} y={pinAt(parked.offset).y - 26} /> : null}
        {state.lastPlace?.id === planet.objectId ? (
          <ShipGlyph x={centre.x - radius * 1.02} y={centre.y + radius * 0.74} />
        ) : null}
      </Svg>
      <SceneLayer>
        {labels.map((label) => {
          const region = regions.find(({ descriptor }) => descriptor.objectId === label.id)!.descriptor;
          return (
            <MapLabel
              key={label.id}
              label={label}
              text={region.label}
              variant={region.objectId === selectedRegion?.objectId ? 'selected' : 'pill'}
            />
          );
        })}
        {regions.map(({ descriptor, offset }) => (
          <BodyTarget
            key={descriptor.objectId}
            testID={`universe-focus-${descriptor.objectId}`}
            x={pinAt(offset).x}
            y={pinAt(offset).y}
            label={descriptor.label}
            kind="region"
            hypothetical={descriptor.truthStatus === 'hypothetical'}
            selected={descriptor.objectId === selectedRegion?.objectId}
            onPress={() => session.focus(descriptor.objectId)}
          />
        ))}
      </SceneLayer>
    </>
  );
}

/**
 * U03 "Low detail": the same silhouette flat on a plain ground, with the same pins in the same
 * layout. The list of regions below it is rendered by the screen, so a drawing that cannot be
 * built still leaves every region reachable.
 */
export function FlatPlanet({
  session,
  index,
  planet,
  width,
  selectedRegion,
}: {
  readonly session: SceneProps['session'];
  readonly index: SceneProps['index'];
  readonly planet: SceneDescriptor;
  readonly width: number;
  readonly selectedRegion: SceneDescriptor | undefined;
}) {
  const geometry = safeGeometry(session, planet, true);
  if (!geometry) return null;
  const height = Math.round(width * 0.56);
  const radius = height * 0.42;
  const centre = { x: width / 2, y: height / 2 };
  const colours = BODY_COLOURS[geometry.palette];
  return (
    <>
      <Svg width={width} height={height} pointerEvents="none" aria-hidden>
        <Rect x={0} y={0} width={width} height={height} rx={14} fill={colours.oceanMid} />
        <Path
          d={silhouettePath(geometry, centre, (radius * 1.15) / geometry.radius)}
          fill={colours.land}
          stroke={colours.stroke}
          strokeWidth={1.5}
          strokeLinejoin="round"
        />
        {composeRegions(index, planet).map(({ descriptor, offset }) => (
          <RegionPin
            key={descriptor.objectId}
            x={centre.x + offset.x * radius * 1.4}
            y={centre.y + offset.y * radius * 1.4}
            size={9}
            selected={descriptor.objectId === selectedRegion?.objectId}
          />
        ))}
      </Svg>
      <SceneLayer>
        {composeRegions(index, planet).map(({ descriptor, offset }) => (
          <BodyTarget
            key={descriptor.objectId}
            testID={`universe-focus-${descriptor.objectId}`}
            x={centre.x + offset.x * radius * 1.4}
            y={centre.y + offset.y * radius * 1.4}
            label={descriptor.label}
            kind="region"
            selected={descriptor.objectId === selectedRegion?.objectId}
            onPress={() => session.focus(descriptor.objectId)}
          />
        ))}
      </SceneLayer>
    </>
  );
}
