import { memo, useId } from 'react';
import { Animated, Pressable, StyleSheet, View } from 'react-native';
import Svg, {
  Circle,
  ClipPath,
  Defs,
  Ellipse,
  G,
  Path,
  RadialGradient,
  Rect,
  Stop,
  Text as SvgText,
} from 'react-native-svg';
import { fontFamily } from '@knowscroll/design-tokens';
import type { Chart, GlobeWorld } from '@knowscroll/scene-core';
import { useFocusRing } from '@knowscroll/ui';
import { useGlobeMotion, type GlobeMotion } from './globe-motion';
import type { PlanetPalette } from './planet-palette';
import { loopsToPath, ringArc } from './svg-paths';
import { useJustDragged } from './use-just-dragged';

/** The band is 480 units round and 360 high; the globe shows 360 of it across its diameter. */
const BAND = 480;
const BAND_HEIGHT = 360;
/** The design's globe is 292 wide, with a ring 430 wide and a moon 40 wide. */
const DESIGN_GLOBE = 292;

const unique = (raw: string) => raw.replaceAll(/[^a-zA-Z0-9]/g, '');

/** The land of one copy of the band: shallows, foam, every continent in colour, patches and coasts. */
function Land({ world, chart, palette }: { world: GlobeWorld; chart: Chart; palette: PlanetPalette }) {
  const coast = loopsToPath(world.land);
  const byColour = palette.land.map((_, colour) => [
    ...world.cells.filter((cell) => cell.site % 4 === colour).flatMap((cell) => cell.loops),
    ...world.decor.filter((_, index) => (index + 1) % 4 === colour).flatMap((decor) => decor.loops),
  ]);
  return (
    <>
      {palette.bands ? <GasBands bands={palette.bands} /> : null}
      <Path d={loopsToPath(world.shallowWide)} fill={palette.shallow} opacity={0.35} fillRule="evenodd" />
      <Path d={loopsToPath(world.shallow)} fill={palette.foam} opacity={0.35} fillRule="evenodd" />
      {palette.glowCoast ? <Path d={coast} fill="none" stroke="#ffb03a" strokeWidth={6} opacity={0.8} /> : null}
      <Path d={coast} fill="none" stroke={palette.foam} strokeWidth={3.6} strokeLinejoin="round" opacity={0.85} />
      {byColour.map((loops, colour) => (
        <Path key={colour} d={loopsToPath(loops)} fill={palette.land[colour]} fillRule="evenodd" />
      ))}
      <Path d={loopsToPath(world.lowland)} fill={palette.lowland} opacity={0.6} fillRule="evenodd" />
      <Path d={loopsToPath(world.highland)} fill={palette.highland} opacity={0.62} fillRule="evenodd" />
      {chart.charted.map((cell) => (
        <Path
          key={cell.objectId}
          d={loopsToPath(cell.loops)}
          fill="none"
          stroke={palette.ink}
          strokeOpacity={0.45}
          strokeWidth={1}
          strokeDasharray="3 3"
        />
      ))}
      <Path d={coast} fill="none" stroke={palette.ink} strokeOpacity={0.7} strokeWidth={1.4} strokeLinejoin="round" />
    </>
  );
}

/** Soft horizontal bands of a gas giant, as flat wavy shapes. */
function GasBands({ bands }: { bands: readonly string[] }) {
  return (
    <>
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

/** A region's name on the globe: ink on a cream edge, drawn as an outline under the letters. */
function Name({ x, y, text, ink }: { x: number; y: number; text: string; ink: string }) {
  const common = {
    x,
    y: y + 5,
    fontFamily: fontFamily.display,
    fontWeight: '800' as const,
    fontSize: 14,
    textAnchor: 'middle' as const,
  };
  return (
    <>
      <SvgText {...common} fill="none" stroke="#fffdf2" strokeWidth={5} strokeLinejoin="round">
        {text}
      </SvgText>
      <SvgText {...common} fill={ink}>
        {text}
      </SvgText>
    </>
  );
}

/**
 * The land band, drawn twice side by side so it can turn without a seam, with the names of the
 * regions that have formed. Decoration: it is hidden from assistive technology, whose way to the
 * regions is the list. Memoised, because only its position changes while the globe turns.
 */
const Surface = memo(function Surface({
  world,
  chart,
  palette,
  labels,
  width,
  height,
}: {
  world: GlobeWorld;
  chart: Chart;
  palette: PlanetPalette;
  labels: ReadonlyMap<string, string>;
  width: number;
  height: number;
}) {
  const id = unique(useId());
  const copy = (index: 0 | 1) => (
    <G key={index} clipPath={`url(#${id}${index})`}>
      <G transform={`translate(${index * BAND} 0)`}>
        <Land world={world} chart={chart} palette={palette} />
        {chart.charted.map((cell) => (
          <Name
            key={cell.objectId}
            x={cell.label.x}
            y={cell.label.y}
            text={labels.get(cell.objectId) ?? ''}
            ink={palette.ink}
          />
        ))}
      </G>
    </G>
  );
  return (
    <Svg width={width} height={height} viewBox={`0 0 ${BAND * 2} ${BAND_HEIGHT}`}>
      <Defs>
        {[0, 1].map((index) => (
          <ClipPath key={index} id={`${id}${index}`}>
            <Rect x={index * BAND} y={0} width={BAND} height={BAND_HEIGHT} />
          </ClipPath>
        ))}
      </Defs>
      {copy(0)}
      {copy(1)}
    </Svg>
  );
});

/** Cumulus seen from orbit: a cast shadow, a cool underside, a white body, brighter middles and a sunlit core. */
const Clouds = memo(function Clouds({
  world,
  palette,
  width,
  height,
}: {
  world: GlobeWorld;
  palette: PlanetPalette;
  width: number;
  height: number;
}) {
  const id = unique(useId());
  const { body, middle, core } = world.clouds;
  const bodyPath = loopsToPath(body);
  const middlePath = loopsToPath(middle);
  const corePath = loopsToPath(core);
  const copy = (index: 0 | 1) => (
    <G key={index} clipPath={`url(#${id}${index})`}>
      <G transform={`translate(${index * BAND} 0)`}>
        <Path d={bodyPath} fill="#06182a" opacity={0.22} fillRule="evenodd" transform="translate(4 7)" />
        <Path d={bodyPath} fill={palette.cloud[1]} opacity={0.9} fillRule="evenodd" transform="translate(0 2)" />
        <Path d={bodyPath} fill={palette.cloud[0]} fillRule="evenodd" />
        <Path d={middlePath} fill="#f6f9fd" fillRule="evenodd" transform="translate(-0.6 -1)" />
        <Path d={corePath} fill="#ffffff" fillRule="evenodd" transform="translate(-1.2 -2)" />
      </G>
    </G>
  );
  return (
    <Svg width={width} height={height} viewBox={`0 0 ${BAND * 2} ${BAND_HEIGHT}`}>
      <Defs>
        {[0, 1].map((index) => (
          <ClipPath key={index} id={`${id}${index}`}>
            <Rect x={index * BAND} y={0} width={BAND} height={BAND_HEIGHT} />
          </ClipPath>
        ))}
      </Defs>
      {copy(0)}
      {copy(1)}
    </Svg>
  );
});

/** The sea behind the land, the shading of the dark side and the glint of the sun: still, over the turning land. */
const Sea = memo(function Sea({ palette, diameter }: { palette: PlanetPalette; diameter: number }) {
  const id = unique(useId());
  const [light, mid, deep, dark] = palette.sea;
  return (
    <Svg width={diameter} height={diameter} viewBox={`0 0 ${diameter} ${diameter}`}>
      <Defs>
        <RadialGradient
          id={`${id}sea`}
          gradientUnits="userSpaceOnUse"
          cx={diameter * 0.38}
          cy={diameter * 0.32}
          r={diameter * 0.92}
        >
          <Stop offset={0} stopColor={light} />
          <Stop offset={0.35} stopColor={mid} />
          <Stop offset={0.72} stopColor={deep} />
          <Stop offset={1} stopColor={dark} />
        </RadialGradient>
      </Defs>
      <Circle cx={diameter / 2} cy={diameter / 2} r={diameter / 2} fill={`url(#${id}sea)`} />
    </Svg>
  );
});

const Shade = memo(function Shade({ palette, diameter }: { palette: PlanetPalette; diameter: number }) {
  const id = unique(useId());
  return (
    <Svg width={diameter} height={diameter} viewBox={`0 0 ${diameter} ${diameter}`} pointerEvents="none">
      <Defs>
        <RadialGradient
          id={`${id}shade`}
          gradientUnits="userSpaceOnUse"
          cx={diameter * 0.31}
          cy={diameter * 0.24}
          r={diameter * 1.026}
        >
          <Stop offset={0} stopColor="rgb(5,15,30)" stopOpacity={0} />
          <Stop offset={0.42} stopColor="rgb(5,15,30)" stopOpacity={0} />
          <Stop offset={0.56} stopColor="rgb(5,15,30)" stopOpacity={0.1} />
          <Stop offset={0.95} stopColor="rgb(3,8,20)" stopOpacity={0.74} />
        </RadialGradient>
        <RadialGradient id={`${id}glint`} cx="50%" cy="50%" r="50%">
          <Stop offset={0} stopColor="#ffffff" stopOpacity={0.3} />
          <Stop offset={1} stopColor="#ffffff" stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Circle cx={diameter / 2} cy={diameter / 2} r={diameter / 2} fill={`url(#${id}shade)`} />
      <Ellipse
        cx={diameter * 0.22}
        cy={diameter * 0.21}
        rx={diameter * 0.23}
        ry={diameter * 0.13}
        fill={`url(#${id}glint)`}
        transform={`rotate(-26 ${diameter * 0.22} ${diameter * 0.21})`}
      />
      {palette.poleCaps ? (
        <G fill="#ffffff" opacity={0.88}>
          <Path
            d={`M${diameter * 0.1} ${diameter * 0.16}Q${diameter * 0.3} ${diameter * 0.07} ${diameter * 0.5} ${diameter * 0.1}Q${diameter * 0.72} ${diameter * 0.06} ${diameter * 0.9} ${diameter * 0.16}Q${diameter * 0.79} ${diameter * 0.24} ${diameter * 0.65} ${diameter * 0.21}Q${diameter * 0.55} ${diameter * 0.27} ${diameter * 0.41} ${diameter * 0.23}Q${diameter * 0.27} ${diameter * 0.26} ${diameter * 0.1} ${diameter * 0.16}Z`}
          />
          <Path
            d={`M${diameter * 0.14} ${diameter * 0.86}Q${diameter * 0.34} ${diameter * 0.81} ${diameter * 0.5} ${diameter * 0.84}Q${diameter * 0.69} ${diameter * 0.79} ${diameter * 0.86} ${diameter * 0.86}Q${diameter * 0.69} ${diameter * 0.98} ${diameter * 0.5} ${diameter * 0.97}Q${diameter * 0.31} ${diameter * 0.99} ${diameter * 0.14} ${diameter * 0.86}Z`}
          />
        </G>
      ) : null}
    </Svg>
  );
});

/** One arc of a planet's ring, behind the globe or in front of it. */
const Ring = memo(function Ring({ palette, front, scale }: { palette: PlanetPalette; front: boolean; scale: number }) {
  const side = 470 * scale;
  const arc = ringArc(215, 48, front);
  return (
    <Svg width={side} height={side} viewBox="-235 -235 470 470" pointerEvents="none">
      <G transform="rotate(-14)" fill="none" strokeLinecap="round">
        <Path d={arc} stroke={palette.ring[0]} strokeWidth={13} opacity={0.9} />
        <Path d={arc} stroke={palette.ring[1]} strokeWidth={4} opacity={0.8} transform="scale(1.05 1.07)" />
        <Path d={arc} stroke={palette.ring[2]} strokeWidth={2} opacity={0.7} transform="scale(0.95 0.93)" />
      </G>
    </Svg>
  );
});

const Moon = memo(function Moon({ side }: { side: number }) {
  return (
    <Svg width={side} height={side} viewBox="0 0 40 40" pointerEvents="none">
      <Circle cx={20} cy={20} r={15.6} fill="#f1ead6" />
      <Path d="M20 4.4A15.6 15.6 0 0 1 20 35.6 20.5 20.5 0 0 0 20 4.4Z" fill="#cbc3aa" />
      <Circle cx={14.6} cy={15} r={4.1} fill="#ddd5bd" />
      <Circle cx={24.4} cy={24.6} r={2.7} fill="#ddd5bd" />
      <Circle cx={15.8} cy={26.4} r={2.1} fill="#ddd5bd" />
    </Svg>
  );
});

export interface PlanetGlobeProps {
  readonly world: GlobeWorld;
  readonly chart: Chart;
  readonly palette: PlanetPalette;
  /** The names of the formed regions, by id. */
  readonly labels: ReadonlyMap<string, string>;
  readonly size: { readonly width: number; readonly height: number };
  /**
   * The camera: its horizontal pan turns the globe, in pixels. A drag may also move it vertically or zoom, and
   * any of those means a finger has just been dragged, not tapped.
   */
  readonly frame: { readonly x: number; readonly y: number; readonly scale: number };
  readonly reducedMotion: boolean;
  readonly rings: boolean;
  readonly moon: boolean;
  /** `undefined` where landing is not offered (a friend's visit, a planet with nothing charted). */
  readonly onLand: (() => void) | undefined;
  readonly landLabel: string;
}

/**
 * U03: a planet from orbit. A turning globe with every continent in full colour under clouds, never
 * grey (D-078), the names of the regions that have formed, a ring and a moon when the planet has
 * them. Dragging turns it by hand; a tap lands on the map. The drawing is hidden from assistive
 * technology; the one control is the "Land on" button.
 */
export function PlanetGlobe(props: PlanetGlobeProps) {
  const { world, chart, palette, labels, size, frame, reducedMotion, rings, moon, onLand, landLabel } = props;
  const diameter = Math.round(Math.min(size.width * 0.75, size.height * 0.36, 420));
  const unit = diameter / BAND_HEIGHT;
  const scale = diameter / DESIGN_GLOBE;
  const centre = { x: size.width / 2, y: size.height * 0.44 };
  const motion = useGlobeMotion({ reducedMotion, spin: frame.x / unit, unit, radius: diameter / 2 });
  const focus = useFocusRing('onDark');
  const bandWidth = BAND * 2 * unit;
  const justDragged = useJustDragged(frame.x, frame.y, frame.scale);
  const land = () => {
    if (!justDragged()) onLand?.();
  };
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <View aria-hidden pointerEvents="none" style={StyleSheet.absoluteFill}>
        {rings ? (
          <View style={[styles.centred, placeAt(centre, 470 * scale)]}>
            <Ring palette={palette} front={false} scale={scale} />
          </View>
        ) : null}
        {moon ? <MoonLayer motion={motion} centre={centre} side={40 * scale} behind /> : null}
        <View
          style={[
            styles.atmosphere,
            {
              left: centre.x - diameter / 2 - 12,
              top: centre.y - diameter / 2 - 12,
              width: diameter + 24,
              height: diameter + 24,
              borderRadius: (diameter + 24) / 2,
              borderColor: `${palette.atmosphere}aa`,
              shadowColor: palette.atmosphere,
            },
          ]}
        />
        <View
          style={[
            styles.globe,
            {
              left: centre.x - diameter / 2,
              top: centre.y - diameter / 2,
              width: diameter,
              height: diameter,
              borderRadius: diameter / 2,
              borderColor: palette.rim,
            },
          ]}
        >
          <View style={StyleSheet.absoluteFill}>
            <Sea palette={palette} diameter={diameter} />
          </View>
          <Animated.View
            style={[styles.band, { width: bandWidth, height: diameter, transform: [{ translateX: motion.surfaceX }] }]}
          >
            <Surface
              world={world}
              chart={chart}
              palette={palette}
              labels={labels}
              width={bandWidth}
              height={diameter}
            />
          </Animated.View>
          <Animated.View
            style={[styles.band, { width: bandWidth, height: diameter, transform: [{ translateX: motion.cloudX }] }]}
          >
            <Clouds world={world} palette={palette} width={bandWidth} height={diameter} />
          </Animated.View>
          <View style={StyleSheet.absoluteFill}>
            <Shade palette={palette} diameter={diameter} />
          </View>
        </View>
        {rings ? (
          <View style={[styles.centred, placeAt(centre, 470 * scale)]}>
            <Ring palette={palette} front scale={scale} />
          </View>
        ) : null}
        {moon ? <MoonLayer motion={motion} centre={centre} side={40 * scale} /> : null}
      </View>
      {onLand ? (
        <Pressable
          testID="universe-land"
          accessibilityRole="button"
          accessibilityLabel={landLabel}
          onPress={land}
          {...focus.props}
          style={[
            styles.land,
            {
              left: centre.x - diameter / 2,
              top: centre.y - diameter / 2,
              width: diameter,
              height: diameter,
              borderRadius: diameter / 2,
            },
            focus.style,
          ]}
        />
      ) : null}
    </View>
  );
}

/** The moon, in front of the globe or behind it: it is shown in the one that matches where it is. */
function MoonLayer({
  motion,
  centre,
  side,
  behind = false,
}: {
  motion: GlobeMotion;
  centre: { x: number; y: number };
  side: number;
  behind?: boolean;
}) {
  return (
    <Animated.View
      style={[
        styles.moon,
        {
          left: centre.x - side / 2,
          top: centre.y - side / 2,
          width: side,
          height: side,
          opacity: behind ? Animated.multiply(motion.moonBehind, 0.7) : motion.moonFront,
          transform: [{ translateX: motion.moonX }, { translateY: motion.moonY }],
        },
      ]}
    >
      <Moon side={side} />
    </Animated.View>
  );
}

const placeAt = (centre: { x: number; y: number }, side: number) => ({
  left: centre.x - side / 2,
  top: centre.y - side / 2,
  width: side,
  height: side,
});

const styles = StyleSheet.create({
  centred: { position: 'absolute' },
  atmosphere: {
    position: 'absolute',
    borderWidth: 1,
    shadowOpacity: 0.4,
    shadowRadius: 26,
    shadowOffset: { width: 0, height: 0 },
  },
  globe: { position: 'absolute', overflow: 'hidden', borderWidth: 2, backgroundColor: 'transparent' },
  band: { position: 'absolute', left: 0, top: 0 },
  moon: { position: 'absolute' },
  land: { position: 'absolute', backgroundColor: 'transparent', cursor: 'pointer' as const },
});
