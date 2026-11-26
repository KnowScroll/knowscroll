import { memo, useEffect, useMemo, useState } from 'react';
import { Animated, Platform, StyleSheet, View } from 'react-native';
import Svg, { Circle, Defs, Ellipse, G, Path, RadialGradient, Rect, Stop } from 'react-native-svg';
import type { SpaceAnchor } from '../space/space-surface';
import {
  ANTENNA_LIGHT,
  BEACON,
  BLINK_PERIOD_MS,
  blinkFrames,
  HOVER_PERIOD_MS,
  hoverFrames,
  IDLE_LIGHT,
  LIVE_LIGHT,
  PULSE_PERIOD_MS,
  pulseFrames,
  skyAlpha,
  skyLights,
  SKY_LIGHT_RADIUS,
  SPRITE,
  stationSize,
  WARM_GLOW_RADIUS,
  type Keyframes,
  type StationLook,
} from './station-look';

/** Out of reach of assistive technology: the stations' buttons name every room, this is only their picture. */
const HIDDEN = {
  'aria-hidden': true,
  importantForAccessibility: 'no-hide-descendants',
  accessibilityElementsHidden: true,
} as const;

/** A station under the Lately lens: dim, as the scene's own is. */
const CALM_OPACITY = 0.5;
/** A clock counts evenly: the keyframes shape what it drives. */
const linearly = (turn: number): number => turn;
/** A native animation runs on the UI thread; the web has none, and says so loudly if asked. */
const NATIVE = Platform.OS !== 'web';

/**
 * A clock that counts 0 to 1 once every `period` ms for as long as `running`, and stands at 0 otherwise. The keyframes
 * of every station read the same one, so a screenful of stations costs three animations, not one each.
 */
function useClock(period: number, running: boolean): Animated.Value | null {
  const [clock] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (!running) return;
    const loop = Animated.loop(
      Animated.timing(clock, { toValue: 1, duration: period, easing: linearly, useNativeDriver: NATIVE }),
    );
    loop.start();
    return () => {
      loop.stop();
      clock.setValue(0);
    };
  }, [clock, period, running]);
  return running ? clock : null;
}

/** What a station's light does with the clock: follows its keyframes, or stands at `still` when there is no clock. */
const follow = (
  clock: Animated.Value | null,
  frames: Keyframes,
  still: number,
): Animated.AnimatedInterpolation<number> | number =>
  clock === null
    ? still
    : clock.interpolate({ inputRange: [...frames.inputRange], outputRange: [...frames.outputRange] });

interface Clocks {
  readonly blink: Animated.Value | null;
  readonly hover: Animated.Value | null;
  readonly pulse: Animated.Value | null;
}

/**
 * The room stations of the trial look, drawn flat over the canvas at their anchors (the prototype's `drawRooms`): the
 * station, a warm glow behind it, a light that blinks, a small hover and, for a member's station, the lights of the
 * constellation. The scene's own station meshes are hidden in this look (`showStations`). Never a place to touch: each
 * station's named button is drawn after this, and this layer takes no touch and is hidden from assistive technology.
 * Under reduced motion nothing moves: the light stays on and the station does not hover.
 */
export function StationLayer({
  anchors,
  looks,
  reducedMotion,
}: {
  /** The stations on screen. */
  readonly anchors: readonly SpaceAnchor[];
  readonly looks: ReadonlyMap<string, StationLook>;
  readonly reducedMotion: boolean;
}) {
  const drawn = anchors.filter((anchor) => looks.has(anchor.id));
  const moving = !reducedMotion && drawn.length > 0;
  const blinking = moving && drawn.some((anchor) => !looks.get(anchor.id)!.live && !looks.get(anchor.id)!.calm);
  const pulsing = moving && drawn.some((anchor) => looks.get(anchor.id)!.live && !looks.get(anchor.id)!.calm);
  const clocks: Clocks = {
    blink: useClock(BLINK_PERIOD_MS, blinking),
    hover: useClock(HOVER_PERIOD_MS, moving),
    pulse: useClock(PULSE_PERIOD_MS, pulsing),
  };
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill} {...HIDDEN} testID="voyage-stations">
      {drawn.map((anchor) => (
        <StationMark
          key={anchor.id}
          id={anchor.id}
          x={anchor.x}
          y={anchor.y}
          width={stationSize(anchor.radiusPx)}
          look={looks.get(anchor.id)!}
          clocks={clocks}
        />
      ))}
    </View>
  );
}

const StationMark = memo(function StationMark({
  id,
  x,
  y,
  width,
  look,
  clocks,
}: {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly look: StationLook;
  readonly clocks: Clocks;
}) {
  const { blink, hover, pulse } = clocks;
  const lift = useMemo(() => follow(hover, hoverFrames(look.phase), 0), [hover, look.phase]);
  const light = useMemo(() => follow(blink, blinkFrames(look.phase), 1), [blink, look.phase]);
  const swell = useMemo(() => follow(pulse, pulseFrames(), 1), [pulse]);
  return (
    <Animated.View
      pointerEvents="none"
      testID={`voyage-station-drawn-${id}`}
      style={[
        styles.mark,
        { left: x, top: y, opacity: look.calm ? CALM_OPACITY : 1, transform: [{ translateY: lift }] },
      ]}
    >
      <View style={[styles.sprite, { transform: [{ scale: width / SPRITE }] }]}>
        <WarmGlow />
        <StationBody
          ring={look.ring.far}
          near={look.ring.near}
          shine={look.ring.shine}
          light={look.live ? LIVE_LIGHT : IDLE_LIGHT}
        />
        {look.calm ? null : look.live ? (
          <Animated.View style={[styles.antenna, { transform: [{ scale: swell }] }]}>
            <LiveGlow />
          </Animated.View>
        ) : (
          <Animated.View style={[styles.spriteFill, { opacity: light }]}>
            <Svg width={SPRITE} height={SPRITE} viewBox={`0 0 ${SPRITE} ${SPRITE}`}>
              <Defs>
                <RadialGradient id="ks-station-light" cx="50%" cy="50%" r="50%">
                  <Stop offset="0" stopColor="#FFA3CF" stopOpacity={0.9} />
                  <Stop offset="1" stopColor="#FF7AB8" stopOpacity={0} />
                </RadialGradient>
                <RadialGradient id="ks-station-beacon" cx="50%" cy="50%" r="50%">
                  <Stop offset="0" stopColor="#FFE44D" stopOpacity={1} />
                  <Stop offset="0.4" stopColor="#FFD63C" stopOpacity={0.5} />
                  <Stop offset="1" stopColor="#FFD63C" stopOpacity={0} />
                </RadialGradient>
              </Defs>
              <Circle
                cx={ANTENNA_LIGHT.x}
                cy={ANTENNA_LIGHT.y}
                r={ANTENNA_LIGHT.radius}
                fill="url(#ks-station-light)"
              />
              <Circle cx={BEACON.x} cy={BEACON.y} r={BEACON.radius} fill="url(#ks-station-beacon)" />
            </Svg>
          </Animated.View>
        )}
      </View>
      {skyLights(width, look.lit).length === 0 ? null : <SkyLights width={width} lit={look.lit} />}
    </Animated.View>
  );
});

/** The soft warm light round a station: 1.5 of its width in radius, at half the prototype's gradient. */
const WarmGlow = memo(function WarmGlow() {
  const reach = SPRITE * WARM_GLOW_RADIUS;
  return (
    <Svg width={2 * reach} height={2 * reach} viewBox={`0 0 ${2 * reach} ${2 * reach}`} style={styles.warm}>
      <Defs>
        <RadialGradient id="ks-station-warm" cx="50%" cy="50%" r="50%">
          <Stop offset="0" stopColor="#FFECAA" stopOpacity={0.17} />
          <Stop offset="1" stopColor="#FFD678" stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Circle cx={reach} cy={reach} r={reach} fill="url(#ks-station-warm)" />
    </Svg>
  );
});

/** A red glow round the antenna light, for a station that is live: its own box, so that it swells about that light. */
const LiveGlow = memo(function LiveGlow() {
  const reach = ANTENNA_LIGHT.radius;
  return (
    <Svg width={2 * reach} height={2 * reach} viewBox={`${-reach} ${-reach} ${2 * reach} ${2 * reach}`}>
      <Defs>
        <RadialGradient id="ks-station-live" cx="50%" cy="50%" r="50%">
          <Stop offset="0" stopColor={LIVE_LIGHT} stopOpacity={0.9} />
          <Stop offset="1" stopColor={LIVE_LIGHT} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Circle cx={0} cy={0} r={reach} fill="url(#ks-station-live)" />
    </Svg>
  );
});

/**
 * The prototype's station (`STATION_SVG`): a cream hub with a dark visor and three yellow lights, blue solar panels, a ring
 * and an antenna, tilted 14 degrees. The ring's three colours and the antenna's light are the room's.
 */
const StationBody = memo(function StationBody({
  ring,
  near,
  shine,
  light,
}: {
  readonly ring: string;
  readonly near: string;
  readonly shine: string;
  readonly light: string;
}) {
  return (
    <Svg width={SPRITE} height={SPRITE} viewBox="0 -15 120 120" style={styles.spriteFill}>
      <G transform="rotate(-14 60 45)">
        <Rect x={22} y={42} width={76} height={5} rx={2} fill="#8D97A3" />
        <Panel x={1} />
        <Panel x={94} />
        <Path d="M30 47A30 10 0 0 1 90 47" fill="none" stroke={ring} strokeWidth={6.5} />
        <Path d="M60 27V15" stroke="#8D97A3" strokeWidth={2.4} strokeLinecap="round" />
        <Circle cx={60} cy={44} r={17.5} fill="#EFE8D8" />
        <Path d="M60 26.5A17.5 17.5 0 0 1 60 61.5A27 27 0 0 0 60 26.5Z" fill="#B9B09B" />
        <Rect x={48.5} y={40} width={23} height={8} rx={4} fill="#22304A" />
        <Path d="M53.5 44h.01M60 44h.01M66.5 44h.01" stroke="#FFE44D" strokeWidth={3.4} strokeLinecap="round" />
        <Ellipse cx={52.5} cy={33.5} rx={5.5} ry={3} fill="#FFFFFF" opacity={0.75} transform="rotate(-24 52.5 33.5)" />
        <Path d="M30 47A30 10 0 0 0 90 47" fill="none" stroke={near} strokeWidth={6.5} strokeLinecap="round" />
        <Path d="M33 48.5A27 7.6 0 0 0 87 48.5" fill="none" stroke={shine} strokeWidth={1.6} strokeLinecap="round" />
        <Circle cx={60} cy={13} r={3.4} fill={light} />
      </G>
    </Svg>
  );
});

/** One solar panel: a blue sheet with its grid and a pale top edge, standing at `x`. */
function Panel({ x }: { readonly x: number }) {
  return (
    <>
      <Rect x={x} y={30} width={25} height={33} rx={2.5} fill="#1D4A93" />
      <Rect x={x} y={27} width={25} height={33} rx={2.5} fill="#3D8BEA" />
      <Path
        d={`M${x + 8.3} 27v33M${x + 16.7} 27v33M${x} 38h25M${x} 49h25`}
        stroke="#2468C4"
        strokeWidth={1.2}
        fill="none"
      />
      <Rect x={x} y={27} width={25} height={5} rx={2.5} fill="#8CC3FF" />
    </>
  );
}

/**
 * The room's constellation (D-174), round a member's station: its lit stars bright, the others a faint ring. They do not
 * turn or twinkle as the prototype's do: a still ring costs nothing to keep.
 */
const SkyLights = memo(function SkyLights({
  width,
  lit,
}: {
  readonly width: number;
  readonly lit: number | undefined;
}) {
  const lights = skyLights(width, lit);
  const reach = Math.max(...lights.map((light) => Math.abs(light.x))) + SKY_LIGHT_RADIUS * 2;
  const rise = Math.max(...lights.map((light) => Math.abs(light.y))) + SKY_LIGHT_RADIUS * 2;
  return (
    <Svg
      width={2 * reach}
      height={2 * rise}
      viewBox={`${-reach} ${-rise} ${2 * reach} ${2 * rise}`}
      style={[styles.sky, { left: -reach, top: -rise, opacity: skyAlpha(width) }]}
      testID="voyage-station-sky"
    >
      <Defs>
        <RadialGradient id="ks-station-star" cx="50%" cy="50%" r="50%">
          <Stop offset="0" stopColor="#FFFDF2" stopOpacity={1} />
          <Stop offset="0.3" stopColor="#FFE496" stopOpacity={0.6} />
          <Stop offset="1" stopColor="#FFD678" stopOpacity={0} />
        </RadialGradient>
      </Defs>
      {lights.map((light, at) =>
        light.lit ? (
          <Circle key={at} cx={light.x} cy={light.y} r={SKY_LIGHT_RADIUS} fill="url(#ks-station-star)" />
        ) : (
          <Circle
            key={at}
            cx={light.x}
            cy={light.y}
            r={2.2}
            fill="none"
            stroke="#FFFDF2"
            strokeOpacity={0.35}
            strokeWidth={1}
          />
        ),
      )}
    </Svg>
  );
});

const styles = StyleSheet.create({
  /** Its left and top are the anchor: the sprite is laid out round that point. */
  mark: { position: 'absolute', width: 0, height: 0 },
  sprite: { position: 'absolute', left: -SPRITE / 2, top: -SPRITE / 2, width: SPRITE, height: SPRITE },
  spriteFill: { position: 'absolute', left: 0, top: 0, width: SPRITE, height: SPRITE },
  warm: { position: 'absolute', left: -SPRITE * (WARM_GLOW_RADIUS - 0.5), top: -SPRITE * (WARM_GLOW_RADIUS - 0.5) },
  /** The red glow's box is centred on the antenna light, so a scale swells it about that light. */
  antenna: {
    position: 'absolute',
    left: ANTENNA_LIGHT.x - ANTENNA_LIGHT.radius,
    top: ANTENNA_LIGHT.y - ANTENNA_LIGHT.radius,
    width: 2 * ANTENNA_LIGHT.radius,
    height: 2 * ANTENNA_LIGHT.radius,
  },
  sky: { position: 'absolute' },
});
