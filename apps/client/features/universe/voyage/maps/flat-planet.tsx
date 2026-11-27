import { memo, useEffect, useId, useMemo, useState } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import Svg, { ClipPath, Defs, G, LinearGradient, Path, Rect, Stop, Text as SvgText } from 'react-native-svg';
import { fontFamily, universe } from '@knowscroll/design-tokens';
import type { Chart, ChartedCell, GlobeWorld } from '@knowscroll/scene-core';
import type { PlanetPalette } from '../../planet/planet-palette';
import { loopsToPath } from '../../planet/svg-paths';
import { mixRgb } from '../../space/paint';
import { centreOfCell } from '../region-centre';
import { BAND_HEIGHT, BAND_WIDTH } from '../world-texture';
import { clipsOf, nameSpots, pointOnScreen, WHOLE_BAND, type Box, type CopyClip, type Size } from './map-layout';

/**
 * The flat drawing of a planet: the globe's own band (`GlobeWorld`, the world the ground and the globe are painted
 * from) as SVG, once round, or cropped to one region with the band repeated either side of the seam. The ground draws
 * the same world as pixels (`world-texture.ts`) and this reads the same chart the same way, so a region is in the same
 * place, in the same colour, with the same grey round it; the land recipe is `planet/planet-globe.tsx`'s `Land`.
 *
 * What it must not do (D-109): land that is not reached is ONE path, from `chart.unreached` merged, with its coast
 * only. It has no name, id, count, veil, border between its pieces or press handler, and nothing in it tells an
 * unformed region from a decorative continent. The whole drawing is out of reach of assistive technology: the
 * regions are reached through the list under it, which names formed regions only.
 */

/** Out of reach of assistive technology: the drawing is decoration, the list is the way to a region. */
const HIDDEN = {
  'aria-hidden': true,
  importantForAccessibility: 'no-hide-descendants',
  accessibilityElementsHidden: true,
} as const;

/** How far land not reached is mixed toward the palette's grey, keeping 0.14 of the first land colour: the texture's `UNREACHED_GREY_MIX`, so the map and the ground show the same grey. */
const GREY_MIX = 0.86;
/** A region's name on the drawing, in layout points. */
const NAME_POINTS = 12;
/** How far dimmed regions are faded in a region's own map. */
const DIMMED = 0.4;
/** The "you were here" dot across, in layout points. */
const HERE_SIZE = 26;
/** The grey path is stroked in its own colour this wide, so two pieces that overlap by a sliver do not leave a hairline hole under the even-odd rule. */
const GREY_OVERLAP = 1;

const unique = (raw: string) => raw.replaceAll(/[^a-zA-Z0-9]/g, '');
const channel = (value: number) => Math.round(value).toString(16).padStart(2, '0');
const channels = (hex: string) =>
  [1, 3, 5].map((from) => Number.parseInt(hex.slice(from, from + 2), 16)) as [number, number, number];

/** The one grey of land not reached, as the texture mixes it: the first land colour toward the palette's grey. */
export function greyOf(palette: PlanetPalette): string {
  const [red, green, blue] = mixRgb(channels(palette.land[0]), channels(palette.grey[0]), GREY_MIX);
  return `#${channel(red)}${channel(green)}${channel(blue)}`;
}

/** Soft horizontal bands of a gas giant, as `planet-globe.tsx` draws them (not exported there). */
function GasBands({ bands }: { bands: readonly string[] }) {
  return (
    <>
      {/* The first band runs up to the top edge, as the texture's does: a gas giant has no sea above it. */}
      <Rect x={-60} y={-20} width={BAND_WIDTH + 120} height={40} fill={bands[0]} />
      {Array.from({ length: 9 }, (_, row) => {
        const y = row * 40;
        let path = `M-60 ${y}`;
        for (let step = 0; step < 11; step++)
          path += `Q${-60 + step * 60 + 30} ${y + (step % 2 ? 9 : -9)} ${-60 + step * 60 + 60} ${y}`;
        return <Path key={row} d={`${path}V${y + 44}H-60Z`} fill={bands[row % bands.length]} />;
      })}
    </>
  );
}

/**
 * Formed regions: each cell in its site's colour, the low and high land and the inked coast kept to these cells, and
 * their borders. Called once for the whole planet, or twice in a region's own map: the other regions faded, then the
 * region itself.
 */
function FormedLand({
  world,
  cells,
  palette,
  emphasised,
  onChoose,
}: {
  world: GlobeWorld;
  cells: readonly ChartedCell[];
  palette: PlanetPalette;
  /** A region's own map: a solid, heavier border instead of the dashed one. */
  emphasised: boolean;
  onChoose: ((objectId: string) => void) | undefined;
}) {
  const id = unique(useId());
  const coast = useMemo(() => loopsToPath(world.land), [world]);
  if (cells.length === 0) return null;
  const union = loopsToPath(cells.flatMap((cell) => cell.loops));
  return (
    <>
      <Defs>
        <ClipPath id={`${id}formed`}>
          <Path d={union} clipRule="evenodd" />
        </ClipPath>
      </Defs>
      {cells.map((cell) => (
        <Path
          key={cell.objectId}
          d={loopsToPath(cell.loops)}
          fill={palette.land[cell.site % 4]}
          fillRule="evenodd"
          {...(onChoose ? { onPress: () => onChoose(cell.objectId) } : {})}
        />
      ))}
      <G clipPath={`url(#${id}formed)`}>
        <Path d={loopsToPath(world.lowland)} fill={palette.lowland} opacity={0.6} fillRule="evenodd" />
        <Path d={loopsToPath(world.highland)} fill={palette.highland} opacity={0.62} fillRule="evenodd" />
        {/* The coast is centred on its line and kept to formed land, so twice the width shows its inner half. */}
        <Path d={coast} fill="none" stroke={palette.ink} strokeOpacity={0.7} strokeWidth={2.8} strokeLinejoin="round" />
      </G>
      {cells.map((cell) => (
        <Path
          key={cell.objectId}
          d={loopsToPath(cell.loops)}
          fill="none"
          stroke={palette.ink}
          strokeOpacity={emphasised ? 0.9 : 0.45}
          strokeWidth={emphasised ? 2 : 1}
          {...(emphasised ? { strokeLinejoin: 'round' as const } : { strokeDasharray: '3 3' })}
        />
      ))}
    </>
  );
}

interface LandProps {
  readonly world: GlobeWorld;
  readonly chart: Chart;
  readonly palette: PlanetPalette;
  /** The turns of the band to draw and the stretch each owns: one for the whole band, two or three for a region by the seam. */
  readonly clips: readonly CopyClip[];
  /** A region's own map: this region in full, the others faded. */
  readonly focusId: string | undefined;
  readonly onChoose: ((objectId: string) => void) | undefined;
}

/**
 * Sea, shallows, coast, land not reached, the world's clouds, then formed land over them, so cloud never lies on a
 * formed region (the ground keeps it off the same way). Memoised: it draws again only for a new world, chart or
 * palette, never while a list under it scrolls.
 */
const Land = memo(function Land({ world, chart, palette, clips, focusId, onChoose }: LandProps) {
  const id = unique(useId());
  const coast = useMemo(() => loopsToPath(world.land), [world]);
  const grey = useMemo(() => loopsToPath(chart.unreached.flatMap((land) => land.loops)), [chart]);
  const greyFill = greyOf(palette);
  const { body, middle, core } = world.clouds;
  const clouds = useMemo(
    () => ({ body: loopsToPath(body), middle: loopsToPath(middle), core: loopsToPath(core) }),
    [body, middle, core],
  );
  const [seaTop, seaBottom] = palette.flatSea;
  const others = focusId === undefined ? [] : chart.charted.filter((cell) => cell.objectId !== focusId);
  const own = focusId === undefined ? chart.charted : chart.charted.filter((cell) => cell.objectId === focusId);
  return (
    <>
      <Defs>
        <LinearGradient id={`${id}sea`} x1="0" y1="0" x2="0" y2="1">
          <Stop offset={0} stopColor={seaTop} />
          <Stop offset={1} stopColor={seaBottom} />
        </LinearGradient>
        <ClipPath id={`${id}grey`}>
          <Path d={grey} clipRule="evenodd" />
        </ClipPath>
        {clips.map(({ turn, left, right }) => (
          <ClipPath key={turn} id={`${id}band${turn}`}>
            <Rect x={left} y={0} width={right - left} height={BAND_HEIGHT} />
          </ClipPath>
        ))}
      </Defs>
      {clips.map(({ turn }) => (
        <G key={turn} clipPath={`url(#${id}band${turn})`}>
          <G transform={`translate(${turn * BAND_WIDTH} 0)`}>
            {/* A little wider than the band: the stretch a turn owns may reach a fraction of a point past its edge. */}
            <Rect x={-2} y={0} width={BAND_WIDTH + 4} height={BAND_HEIGHT} fill={`url(#${id}sea)`} />
            {palette.bands ? <GasBands bands={palette.bands} /> : null}
            <Path d={loopsToPath(world.shallowWide)} fill={palette.shallow} opacity={0.35} fillRule="evenodd" />
            <Path d={loopsToPath(world.shallow)} fill={palette.foam} opacity={0.35} fillRule="evenodd" />
            {palette.glowCoast ? <Path d={coast} fill="none" stroke="#ffb03a" strokeWidth={6} opacity={0.8} /> : null}
            <Path d={coast} fill="none" stroke={palette.foam} strokeWidth={3.6} strokeLinejoin="round" opacity={0.85} />
            {/* Land not reached: ONE path, one colour, no border of its own, no id, nothing to press. */}
            <Path d={grey} fill={greyFill} stroke={greyFill} strokeWidth={GREY_OVERLAP} fillRule="evenodd" />
            {/* Its coast is the world's coast (where land meets sea), never the lines between its pieces. */}
            <G clipPath={`url(#${id}grey)`}>
              <Path
                d={coast}
                fill="none"
                stroke={palette.grey[2]}
                strokeOpacity={0.6}
                strokeWidth={2.8}
                strokeLinejoin="round"
              />
            </G>
            <Path d={clouds.body} fill="#06182a" opacity={0.22} fillRule="evenodd" transform="translate(4 7)" />
            <Path d={clouds.body} fill={palette.cloud[1]} opacity={0.9} fillRule="evenodd" transform="translate(0 2)" />
            <Path d={clouds.body} fill={palette.cloud[0]} fillRule="evenodd" />
            <Path d={clouds.middle} fill="#f6f9fd" fillRule="evenodd" transform="translate(-0.6 -1)" />
            <Path d={clouds.core} fill="#ffffff" fillRule="evenodd" transform="translate(-1.2 -2)" />
            {others.length === 0 ? null : (
              <G opacity={DIMMED}>
                <FormedLand world={world} cells={others} palette={palette} emphasised={false} onChoose={undefined} />
              </G>
            )}
            <FormedLand
              world={world}
              cells={own}
              palette={palette}
              emphasised={focusId !== undefined}
              onChoose={onChoose}
            />
          </G>
        </G>
      ))}
    </>
  );
});

/** A region's name on the drawing: ink on a cream edge, as the globe writes them. */
function Name({ x, y, text, size, ink }: { x: number; y: number; text: string; size: number; ink: string }) {
  const common = {
    x,
    // The baseline sits a third of the type's size below the point, so the name is centred on it.
    y: y + size * 0.35,
    fontFamily: fontFamily.display,
    fontWeight: '800' as const,
    fontSize: size,
    textAnchor: 'middle' as const,
  };
  return (
    <>
      <SvgText {...common} fill="none" stroke="#fffdf2" strokeWidth={size * 0.36} strokeLinejoin="round">
        {text}
      </SvgText>
      <SvgText {...common} fill={ink}>
        {text}
      </SvgText>
    </>
  );
}

/** The orange dot of "you were here", with a ripple unless motion is reduced. */
function HereMarker({ x, y, reducedMotion }: { x: number; y: number; reducedMotion: boolean }) {
  const [ripple] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (reducedMotion) {
      ripple.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(ripple, {
        toValue: 1,
        duration: 2600,
        easing: (t) => 1 - (1 - t) * (1 - t),
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [reducedMotion, ripple]);
  return (
    <View
      testID="flat-planet-here"
      pointerEvents="none"
      style={[styles.marker, { left: x - HERE_SIZE / 2, top: y - HERE_SIZE / 2 }]}
    >
      {reducedMotion ? null : (
        <Animated.View
          style={[
            styles.ripple,
            {
              opacity: ripple.interpolate({ inputRange: [0, 1], outputRange: [0.9, 0] }),
              transform: [{ scale: ripple.interpolate({ inputRange: [0, 1], outputRange: [0.6, 2.4] }) }],
            },
          ]}
        />
      )}
      <View style={styles.markerDot}>
        <View style={styles.markerCore} />
      </View>
    </View>
  );
}

export interface FlatPlanetProps {
  readonly world: GlobeWorld;
  readonly chart: Chart;
  readonly palette: PlanetPalette;
  /** The name of each formed region, by id. Only these are ever written on the drawing. */
  readonly names: ReadonlyMap<string, string>;
  /** The drawing's size in layout points. */
  readonly size: Size;
  /** The part of the band to show, in band units: the whole band by default. */
  readonly box?: Box;
  /** A region's own map: this region in full and unnamed, the others faded and unnamed. Leave out for the whole planet. */
  readonly focusId?: string;
  /** The region left through Open: an orange dot. The list under the map says it in words; the dot alone keeps a crowded cluster of names readable. */
  readonly hereId?: string | null | undefined;
  readonly reducedMotion: boolean;
  /** A tap on a formed region's land. Leave out where land is not for choosing (a region's own map). */
  readonly onChoose?: (objectId: string) => void;
}

/** The planet as a flat drawing (see the top of this file). Not a tab stop and not read out; the list under it is. */
export function FlatPlanet({
  world,
  chart,
  palette,
  names,
  size,
  box = WHOLE_BAND,
  focusId,
  hereId,
  reducedMotion,
  onChoose,
}: FlatPlanetProps) {
  const scale = size.width / box.width;
  const clips = useMemo(() => clipsOf(box, scale), [box, scale]);
  const fontUnits = NAME_POINTS / scale;
  const hereCell =
    hereId === null || hereId === undefined ? undefined : chart.charted.find((cell) => cell.objectId === hereId);
  // Names are written on the whole planet only: in a region's own map its title says whose it is. The dot is placed
  // with the names, so it never covers one.
  const plan = useMemo(
    () =>
      focusId === undefined
        ? nameSpots(
            chart.charted,
            names,
            fontUnits,
            hereCell === undefined ? undefined : { objectId: hereCell.objectId, markerUnits: HERE_SIZE / scale },
          )
        : null,
    [chart, names, fontUnits, focusId, hereCell, scale],
  );
  // In a region's own map the dot stands on the region's own point, which may be past the seam, where the crop is.
  const herePoint = useMemo(() => {
    if (hereCell === undefined) return undefined;
    const point = plan === null ? centreOfCell(hereCell, BAND_WIDTH) : plan.marker;
    return point === null ? undefined : pointOnScreen(point, box, size);
  }, [hereCell, plan, box, size]);
  return (
    <View testID="flat-planet" style={{ width: size.width, height: size.height }} {...HIDDEN}>
      <Svg width={size.width} height={size.height} viewBox={`${box.x} ${box.y} ${box.width} ${box.height}`}>
        <Land world={world} chart={chart} palette={palette} clips={clips} focusId={focusId} onChoose={onChoose} />
        {(plan?.names ?? []).map((spot) => (
          <Name
            key={spot.objectId}
            x={spot.x}
            y={spot.y}
            text={names.get(spot.objectId) ?? ''}
            size={fontUnits}
            ink={palette.ink}
          />
        ))}
      </Svg>
      {herePoint === undefined ? null : <HereMarker x={herePoint.x} y={herePoint.y} reducedMotion={reducedMotion} />}
    </View>
  );
}

const styles = StyleSheet.create({
  marker: { position: 'absolute', width: HERE_SIZE, height: HERE_SIZE, alignItems: 'center', justifyContent: 'center' },
  ripple: {
    position: 'absolute',
    width: HERE_SIZE,
    height: HERE_SIZE,
    borderRadius: HERE_SIZE / 2,
    borderWidth: 2,
    borderColor: '#ffffff',
  },
  markerDot: {
    width: HERE_SIZE,
    height: HERE_SIZE,
    borderRadius: HERE_SIZE / 2,
    backgroundColor: universe.orange,
    borderWidth: 2.5,
    borderColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  markerCore: { width: 9, height: 9, borderRadius: 4.5, backgroundColor: '#ffffff' },
});
