import { memo, useId, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Circle, Defs, Path, RadialGradient, Rect, Stop } from 'react-native-svg';
import { universe } from '@knowscroll/design-tokens';
import { Text } from '@knowscroll/ui';
import { BUBBLE_COLOURS, BUBBLE_DOT, BUBBLE_SIZE, bubbleDots } from './crossing-bubble';
import type { CrossingBubble, CrossingFrame, CrossingLabel, CrossingName } from './crossing-frame';

/** The ring's yellow: the Universe's focus colour. */
const RING_COLOUR = universe.focus;
/** The film's text is Paper on the sky, with a dark halo so it reads over bright gas. */
const TEXT_COLOUR = universe.label;
const TEXT_SHADOW = 'rgba(0,0,0,0.95)';
/** A line of text is centred in a box this wide; wider than any line the film draws on a phone. */
const LABEL_BOX = 320;

/** `#rrggbb` as the `r,g,b` of an `rgba()`. */
function channels(hex: string): string {
  return `${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)}`;
}

/** The path of one arc of a ring, from `start` for `length` radians, clockwise on screen. */
function arcPath(x: number, y: number, radius: number, start: number, length: number): string {
  const from = [x + Math.cos(start) * radius, y + Math.sin(start) * radius] as const;
  const to = [x + Math.cos(start + length) * radius, y + Math.sin(start + length) * radius] as const;
  return `M ${from[0]} ${from[1]} A ${radius} ${radius} 0 0 1 ${to[0]} ${to[1]}`;
}

/** A universe's bubble: the halo and the web of dots for a seed, drawn once and scaled by the caller. */
const BubbleSprite = memo(function BubbleSprite({ seed }: { readonly seed: string }) {
  const dots = useMemo(() => bubbleDots(seed), [seed]);
  const half = BUBBLE_SIZE / 2;
  const instance = useId();
  // Two sprites share a document on the web, so each names its own gradient.
  const haloId = `crossing-bubble-halo-${instance.replace(/[^a-zA-Z0-9]/g, '')}`;
  return (
    <Svg width={BUBBLE_SIZE} height={BUBBLE_SIZE} viewBox={`0 0 ${BUBBLE_SIZE} ${BUBBLE_SIZE}`}>
      <Defs>
        <RadialGradient id={haloId} cx={half} cy={half} r={BUBBLE_SIZE * 0.5} gradientUnits="userSpaceOnUse">
          <Stop offset="0.6" stopColor="rgb(255,220,180)" stopOpacity="0" />
          <Stop offset="0.72" stopColor="rgb(255,226,190)" stopOpacity="0.28" />
          <Stop offset="1" stopColor="rgb(255,200,150)" stopOpacity="0" />
        </RadialGradient>
      </Defs>
      <Rect x="0" y="0" width={BUBBLE_SIZE} height={BUBBLE_SIZE} fill={`url(#${haloId})`} />
      {dots.map((dot, index) => (
        <Rect
          key={index}
          x={dot.x}
          y={dot.y}
          width={BUBBLE_DOT}
          height={BUBBLE_DOT}
          fill={BUBBLE_COLOURS[dot.colour]}
          fillOpacity={0.75}
        />
      ))}
    </Svg>
  );
});

/** A bubble sprite placed at a centre and radius (layout px) with the alpha the film asks for. */
function PlacedBubble({
  bubble,
  seed,
  testID,
}: {
  readonly bubble: CrossingBubble;
  readonly seed: string;
  readonly testID: string;
}) {
  return (
    <View
      testID={testID}
      pointerEvents="none"
      style={[
        styles.sprite,
        {
          left: bubble.x - BUBBLE_SIZE / 2,
          top: bubble.y - BUBBLE_SIZE / 2,
          opacity: bubble.alpha,
          transform: [{ scale: (bubble.radius * 2) / BUBBLE_SIZE }],
        },
      ]}
    >
      <BubbleSprite seed={seed} />
    </View>
  );
}

/** One line of the film. Header lines are mono capitals; the others, names, are in the display face. */
function FilmLabel({ label, testID }: { readonly label: CrossingLabel | CrossingName; readonly testID: string }) {
  const mono = 'mono' in label && label.mono;
  const alpha = label.alpha;
  const size = label.size;
  return (
    <View
      testID={testID}
      pointerEvents="none"
      style={[styles.labelBox, { left: label.x - LABEL_BOX / 2, top: label.y, opacity: alpha }]}
    >
      {mono ? (
        // A line is as tall as its text, so its top is where the prototype hangs it from.
        <Text
          variant="label"
          color={TEXT_COLOUR}
          align="center"
          style={[styles.shadow, { lineHeight: Math.ceil(size) }]}
        >
          {label.text}
        </Text>
      ) : (
        // The film scales a name continuously as it drifts out, so its size is set here rather than by a role.
        <Text
          variant="title"
          color={TEXT_COLOUR}
          align="center"
          style={[styles.shadow, { fontSize: size, lineHeight: Math.ceil(size) }]}
        >
          {label.text}
        </Text>
      )}
    </View>
  );
}

/**
 * The 2D marks of the crossing laid over the shader: the two bubbles, the ring closing on the other one, the header
 * lines, the shared names drifting out of the far end, and the white flash. Pure drawing of one {@link CrossingFrame};
 * decorative, so hidden from assistive technology: the visit says where the person is going in a live region of its own
 * (`features/visit/visit-crossing.tsx`).
 */
export function CrossingMarks({
  frame,
  size,
  behindSeed,
  aheadSeed,
}: {
  readonly frame: CrossingFrame;
  readonly size: { readonly width: number; readonly height: number };
  /** The bubble you are leaving: yours on the way out, the friend's on the way home. */
  readonly behindSeed: string;
  /** The bubble you are heading for. */
  readonly aheadSeed: string;
}) {
  const { ahead, behind, ring, names, labels } = frame;
  const far = channels(frame.shader.colours.b);
  return (
    <View
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
    >
      {behind === null ? null : <PlacedBubble bubble={behind} seed={behindSeed} testID="ks-crossing-behind" />}
      {ahead === null ? null : (
        <View testID="ks-crossing-halo" pointerEvents="none" style={StyleSheet.absoluteFill}>
          <Svg width={size.width} height={size.height}>
            <Defs>
              <RadialGradient
                id="crossing-ahead-halo"
                gradientUnits="userSpaceOnUse"
                cx={ahead.x}
                cy={ahead.y}
                r={ahead.haloRadius}
              >
                <Stop offset="0.25" stopColor={`rgb(${far})`} stopOpacity={ahead.haloAlpha} />
                <Stop offset="1" stopColor={`rgb(${far})`} stopOpacity="0" />
              </RadialGradient>
            </Defs>
            <Circle
              cx={ahead.x}
              cy={ahead.y}
              r={ahead.haloRadius}
              fill="url(#crossing-ahead-halo)"
              opacity={ahead.alpha}
            />
          </Svg>
        </View>
      )}
      {ahead === null ? null : <PlacedBubble bubble={ahead} seed={aheadSeed} testID="ks-crossing-ahead" />}
      {ring === null ? null : (
        <View testID="ks-crossing-ring" pointerEvents="none" style={StyleSheet.absoluteFill}>
          <Svg width={size.width} height={size.height}>
            {Array.from({ length: ring.arcCount }, (_, arc) => (
              <Path
                key={arc}
                d={arcPath(ring.x, ring.y, ring.radius, (arc * Math.PI) / 2 + ring.spin, ring.arcLength)}
                stroke={RING_COLOUR}
                strokeWidth={2}
                fill="none"
                opacity={ring.alpha}
              />
            ))}
          </Svg>
        </View>
      )}
      {names.length === 0 ? null : (
        <View pointerEvents="none" style={StyleSheet.absoluteFill}>
          <Svg width={size.width} height={size.height}>
            <Defs>
              <RadialGradient id="crossing-name-glow" cx="0.5" cy="0.5" r="0.5">
                <Stop offset="0" stopColor="rgb(255,253,242)" stopOpacity="0.9" />
                <Stop offset="0.4" stopColor="rgb(255,228,150)" stopOpacity="0.4" />
                <Stop offset="1" stopColor="rgb(255,214,120)" stopOpacity="0" />
              </RadialGradient>
            </Defs>
            {names.map((name) => (
              <Circle
                key={name.index}
                cx={name.glow.x}
                cy={name.glow.y}
                r={name.glow.radius}
                fill="url(#crossing-name-glow)"
                opacity={name.alpha}
              />
            ))}
          </Svg>
        </View>
      )}
      {labels.map((label) => (
        <FilmLabel key={label.key} label={label} testID={`ks-crossing-label-${label.key}`} />
      ))}
      {names.map((name) => (
        <FilmLabel key={name.index} label={name} testID={`ks-crossing-name-${name.index}`} />
      ))}
      {frame.flash > 0.01 ? (
        <View
          testID="ks-crossing-flash"
          style={[styles.flash, { backgroundColor: `rgba(255,250,240,${frame.flash})` }]}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  sprite: { position: 'absolute', width: BUBBLE_SIZE, height: BUBBLE_SIZE },
  labelBox: { position: 'absolute', width: LABEL_BOX, alignItems: 'center' },
  shadow: { textShadowColor: TEXT_SHADOW, textShadowRadius: 6, textShadowOffset: { width: 0, height: 0 } },
  flash: { position: 'absolute', left: -20, top: -20, right: -20, bottom: -20 },
});
