import { StyleSheet, View } from 'react-native';
import Svg, { Circle, Defs, Mask, RadialGradient, Rect, Stop } from 'react-native-svg';
import { space } from '@knowscroll/design-tokens';
import type { SpaceAnchor } from '../space/space-surface';

/**
 * What the sky shows while search is open: `lit` are the systems that hold a match for what is typed, null while nothing
 * is typed.
 */
export interface SearchAnswer {
  readonly lit: readonly string[] | null;
}

/** The sky's flat dim while nothing is typed (U08): as the map dims under the search card. */
const IDLE_DIM = 'rgba(2,3,8,0.5)';
/** The prototype drops a star that holds no match to 0.28 of its light: black laid over it at the rest. */
const MISS_DIM = 'rgba(2,3,8,0.72)';
/** The prototype's `PICK` glow round a lit star: 72 points across, a soft yellow that fades to nothing. */
const GLOW_SIZE = 72;
const GLOW_STOPS = [
  { offset: 0, opacity: 0.55 },
  { offset: 0.45, opacity: 0.3 },
  { offset: 1, opacity: 0 },
] as const;
/** The thin ring inside the glow: the cue that does not depend on seeing a soft light. */
const RING_RADIUS = 18;
const RING_WIDTH = 2;
/** A star drawn bigger than the ring (the one you are at) is ringed this far outside its edge, with its glow grown to match. */
const RING_GAP = 6;

/** A lit star's ring and glow: the prototype's 72 points across for a small star, grown round a large one. */
export function ringOf(radiusPx: number): { readonly ring: number; readonly glow: number } {
  const ring = Math.max(RING_RADIUS, radiusPx + RING_GAP);
  return { ring, glow: Math.max(GLOW_SIZE, (ring * GLOW_SIZE) / RING_RADIUS) };
}
/** The sky keeps its light round a lit star, and its name, out to about half this share of the glow's width, fading back to the dim by the whole of it. */
const HOLE_SHARE = 0.9;

/** The lit systems that are on screen: where their rings go. */
export function litAnchors(anchors: readonly SpaceAnchor[], lit: readonly string[]): readonly SpaceAnchor[] {
  return anchors.filter((anchor) => anchor.kind === 'system' && anchor.visible && lit.includes(anchor.id));
}

/**
 * The sky's answer to a search, over the canvas and under the names' buttons (it takes no touch and is hidden from
 * assistive technology: the results list is how a person chooses). With nothing typed, a flat dim. With a query, the sky
 * dims to the prototype's 28 % everywhere but round the systems that hold a match, which keep their light and wear a
 * soft yellow glow and a ring. No part of it moves of its own: the rings follow their stars as the camera flies.
 */
export function SearchSky({
  answer,
  anchors,
  size,
}: {
  readonly answer: SearchAnswer;
  /** Every system this stop draws, with where it is on screen. */
  readonly anchors: readonly SpaceAnchor[];
  readonly size: { readonly width: number; readonly height: number };
}) {
  const hidden = { 'aria-hidden': true, importantForAccessibility: 'no-hide-descendants' } as const;
  if (answer.lit === null)
    return (
      <View
        pointerEvents="none"
        testID="universe-search-dim"
        style={[StyleSheet.absoluteFill, { backgroundColor: IDLE_DIM }]}
        {...hidden}
      />
    );
  const lit = litAnchors(anchors, answer.lit);
  return (
    <View pointerEvents="none" testID="voyage-search-sky" style={StyleSheet.absoluteFill} {...hidden}>
      <Svg width={size.width} height={size.height} style={StyleSheet.absoluteFill}>
        <Defs>
          <RadialGradient id="ks-search-hole" cx="50%" cy="50%" r="50%">
            <Stop offset="0.55" stopColor="#000" stopOpacity={1} />
            <Stop offset="1" stopColor="#000" stopOpacity={0} />
          </RadialGradient>
          <Mask id="ks-search-dim" x={0} y={0} width={size.width} height={size.height}>
            <Rect x={0} y={0} width={size.width} height={size.height} fill="#fff" />
            {lit.map((anchor) => (
              <Circle
                key={anchor.id}
                cx={anchor.x}
                cy={anchor.y}
                r={ringOf(anchor.radiusPx).glow * HOLE_SHARE}
                fill="url(#ks-search-hole)"
              />
            ))}
          </Mask>
        </Defs>
        <Rect x={0} y={0} width={size.width} height={size.height} fill={MISS_DIM} mask="url(#ks-search-dim)" />
      </Svg>
      {lit.map((anchor) => {
        // Gradient ids are the page's own on the web: each star's glow is a gradient of its own.
        const gradient = `ks-search-glow-${anchor.id}`;
        const { ring, glow } = ringOf(anchor.radiusPx);
        return (
          <View
            key={anchor.id}
            testID={`voyage-search-lit-${anchor.id}`}
            style={{
              position: 'absolute',
              width: glow,
              height: glow,
              left: anchor.x - glow / 2,
              top: anchor.y - glow / 2,
            }}
          >
            <Svg width={glow} height={glow}>
              <Defs>
                <RadialGradient id={gradient} cx="50%" cy="50%" r="50%">
                  {GLOW_STOPS.map((stop) => (
                    <Stop key={stop.offset} offset={stop.offset} stopColor={space.focus} stopOpacity={stop.opacity} />
                  ))}
                </RadialGradient>
              </Defs>
              <Circle cx={glow / 2} cy={glow / 2} r={glow / 2} fill={`url(#${gradient})`} />
              <Circle cx={glow / 2} cy={glow / 2} r={ring} fill="none" stroke={space.focus} strokeWidth={RING_WIDTH} />
            </Svg>
          </View>
        );
      })}
    </View>
  );
}
