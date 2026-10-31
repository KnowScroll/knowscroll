import { useId } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Circle, Defs, Ellipse, RadialGradient, Stop } from 'react-native-svg';
import { paletteOf } from '../planet/planet-palette';
import { HAZE_COLOURS, type HazeFamily } from '../space/planet-genome';
import type { DialPlanet } from './dial-model';

/** The sun's own colours: always orange, whatever the haze (D-006). */
const SUN = ['#FFF3C4', '#FFB743', '#FF7A1F'] as const;

/**
 * A system as the wheel draws it: an orange sun with its haze, flat and painted (the design draws
 * these with the real scene code; the dial is a list of small pictures, so it paints them in SVG
 * with no 3D). The haze only tints; it never says how much was read.
 */
export function SunDisc({
  size,
  haze,
  quiet = false,
}: {
  readonly size: number;
  readonly haze: HazeFamily;
  readonly quiet?: boolean;
}) {
  const id = useId().replaceAll(':', '');
  const [inner, outer] = HAZE_COLOURS[haze];
  // The sun is 22 % of the picture's width: `size` is the sun's own diameter, and the haze spreads wider than it.
  const span = size / 0.22;
  return (
    <View
      aria-hidden
      style={[styles.disc, { width: span, height: span, opacity: quiet ? 0.5 : 1 }]}
      pointerEvents="none"
    >
      <Svg width={span} height={span} viewBox="0 0 100 100">
        <Defs>
          <RadialGradient id={`${id}h`} cx="50" cy="50" r="50" gradientUnits="userSpaceOnUse">
            <Stop offset="0" stopColor={inner} stopOpacity={0.55} />
            <Stop offset="0.5" stopColor={outer} stopOpacity={0.28} />
            <Stop offset="1" stopColor={outer} stopOpacity={0} />
          </RadialGradient>
          <RadialGradient id={`${id}s`} cx="42" cy="40" r="14" gradientUnits="userSpaceOnUse">
            <Stop offset="0" stopColor={SUN[0]} />
            <Stop offset="0.6" stopColor={SUN[1]} />
            <Stop offset="1" stopColor={SUN[2]} />
          </RadialGradient>
        </Defs>
        <Ellipse cx="50" cy="50" rx="50" ry="26" fill={`url(#${id}h)`} />
        <Circle cx="50" cy="50" r="11" fill={`url(#${id}s)`} />
      </Svg>
    </View>
  );
}

/**
 * A planet as the dial draws it, small: a flat painted ball in its type's own colours, with its ring
 * when its look gives it one. The big planet of the dial is the real globe.
 */
export function PlanetDisc({ planet, size }: { readonly planet: DialPlanet; readonly size: number }) {
  const id = useId().replaceAll(':', '');
  const palette = paletteOf(planet.type, planet.hueShift);
  const span = size * (planet.rings ? 1.9 : 1);
  return (
    <View aria-hidden style={[styles.disc, { width: span, height: size }]} pointerEvents="none">
      <Svg width={span} height={size} viewBox={`${planet.rings ? -24 : 0} 0 ${planet.rings ? 148 : 100} 100`}>
        <Defs>
          <RadialGradient id={id} cx="36" cy="34" r="62" gradientUnits="userSpaceOnUse">
            <Stop offset="0" stopColor={palette.sea[0]} />
            <Stop offset="0.5" stopColor={palette.sea[1]} />
            <Stop offset="1" stopColor={palette.sea[3]} />
          </RadialGradient>
        </Defs>
        {planet.rings ? (
          <Ellipse cx="50" cy="52" rx="68" ry="15" fill="none" stroke={palette.ring[0]} strokeWidth={5} />
        ) : null}
        <Circle cx="50" cy="50" r="38" fill={`url(#${id})`} stroke={palette.rim} strokeWidth={2} />
        <Circle cx="38" cy="44" r="11" fill={palette.land[1]} opacity={0.9} />
        <Circle cx="60" cy="62" r="8" fill={palette.land[2]} opacity={0.9} />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({ disc: { alignItems: 'center', justifyContent: 'center' } });
