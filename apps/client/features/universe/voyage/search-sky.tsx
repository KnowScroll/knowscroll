import { StyleSheet, View } from 'react-native';
import Svg, { Circle, Defs, Mask, RadialGradient, Rect, Stop } from 'react-native-svg';
import { space } from '@knowscroll/design-tokens';
import type { SpaceAnchor } from '../space/space-surface';

/**
 * What the sky shows while search is open: `lit` are the systems that hold a match for what is typed, null while nothing
 * is typed. With `shows: 'common'` it is a friend's Universe answering "What we have in common" instead: `lit` are the
 * friend's systems you have too (never null), drawn by {@link CommonSky}.
 */
export interface SearchAnswer {
  readonly lit: readonly string[] | null;
  readonly shows?: 'match' | 'common';
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
/** "What we have in common": a star that is not shared drops to 25 % of its light, so black at 75 % lies over the sky. */
const COMMON_DIM = 'rgba(2,3,8,0.75)';
/** A shared star wears a 2 px ring of radius 9, in the focus yellow; a star drawn larger is ringed just outside its edge. */
const COMMON_RING = 9;
const COMMON_RING_WIDTH = 2;
const COMMON_RING_GAP = 3;
/** The dim leaves a shared star its light out to about half of this radius, and is whole again by all of it. */
const COMMON_HOLE = 3 * COMMON_RING;

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

/** The ring round a shared star: the prototype's radius 9, grown only for a star drawn larger than that. */
export const commonRingOf = (radiusPx: number): number => Math.max(COMMON_RING, radiusPx + COMMON_RING_GAP);

/**
 * The sky's answer to "What we have in common" on a friend's Universe: everywhere but round the shared systems the sky
 * drops to 25 % of its light, and each shared system wears a 2 px yellow ring. It is drawn under the names, which dim by
 * themselves (the stage sets an unshared name to 0.4), so a shared name keeps its full light. Like {@link SearchSky} it
 * takes no touch, is hidden from assistive technology (the systems' own buttons say which are shared), and moves with
 * its stars as the camera flies. Nothing is dimmed when no system is shared: there is nothing to show against.
 */
export function CommonSky({
  shared,
  anchors,
  size,
}: {
  readonly shared: readonly string[];
  readonly anchors: readonly SpaceAnchor[];
  readonly size: { readonly width: number; readonly height: number };
}) {
  const hidden = { 'aria-hidden': true, importantForAccessibility: 'no-hide-descendants' } as const;
  if (shared.length === 0) return null;
  const rings = litAnchors(anchors, shared);
  return (
    <View pointerEvents="none" testID="voyage-common-sky" style={StyleSheet.absoluteFill} {...hidden}>
      <Svg width={size.width} height={size.height} style={StyleSheet.absoluteFill}>
        <Defs>
          <RadialGradient id="ks-common-hole" cx="50%" cy="50%" r="50%">
            <Stop offset="0.5" stopColor="#000" stopOpacity={1} />
            <Stop offset="1" stopColor="#000" stopOpacity={0} />
          </RadialGradient>
          <Mask id="ks-common-dim" x={0} y={0} width={size.width} height={size.height}>
            <Rect x={0} y={0} width={size.width} height={size.height} fill="#fff" />
            {rings.map((anchor) => (
              <Circle
                key={anchor.id}
                cx={anchor.x}
                cy={anchor.y}
                r={Math.max(COMMON_HOLE, 2 * commonRingOf(anchor.radiusPx))}
                fill="url(#ks-common-hole)"
              />
            ))}
          </Mask>
        </Defs>
        <Rect x={0} y={0} width={size.width} height={size.height} fill={COMMON_DIM} mask="url(#ks-common-dim)" />
      </Svg>
      {rings.map((anchor) => {
        // One element per ring, so a test (and a reader of the DOM) can tell which systems are ringed.
        const radius = commonRingOf(anchor.radiusPx);
        const side = 2 * (radius + COMMON_RING_WIDTH);
        return (
          <View
            key={anchor.id}
            testID={`voyage-common-ring-${anchor.id}`}
            style={{
              position: 'absolute',
              width: side,
              height: side,
              left: anchor.x - side / 2,
              top: anchor.y - side / 2,
            }}
          >
            <Svg width={side} height={side}>
              <Circle
                cx={side / 2}
                cy={side / 2}
                r={radius}
                fill="none"
                stroke={space.focus}
                strokeWidth={COMMON_RING_WIDTH}
              />
            </Svg>
          </View>
        );
      })}
    </View>
  );
}
