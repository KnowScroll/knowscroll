import { useState } from 'react';
import { Pressable, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { CONSTELLATION_POINTS } from '@knowscroll/client-core';
import { space } from '@knowscroll/design-tokens';

/** The art is at most this wide and keeps this shape; on a narrower column it shrinks with it (a 320 px screen has 280 px). */
const MAX_WIDTH = 288;
const ASPECT = 168 / 288;
const TARGET = 44;
const DOT = 18;

/**
 * Where star `index` is drawn in an art `width` wide. The points are spread over the box inside the 44 px touch targets, so a star at
 * the edge keeps its whole target inside the art and nothing hangs out of a narrow column.
 */
const at = (index: number, width: number): { readonly x: number; readonly y: number } => {
  const [x, y] = CONSTELLATION_POINTS[index]!;
  const height = width * ASPECT;
  return { x: TARGET / 2 + x * (width - TARGET), y: TARGET / 2 + y * (height - TARGET) };
};

/** A thin straight line between two lit stars, drawn as a turned strip centred on their midpoint. */
function Segment({ from, to, width }: { readonly from: number; readonly to: number; readonly width: number }) {
  const first = at(from, width);
  const second = at(to, width);
  const length = Math.hypot(second.x - first.x, second.y - first.y);
  const angle = Math.atan2(second.y - first.y, second.x - first.x);
  return (
    <View
      aria-hidden
      style={[
        styles.line,
        {
          width: length,
          left: (first.x + second.x) / 2 - length / 2,
          top: (first.y + second.y) / 2 - 1,
          transform: [{ rotate: `${String(angle)}rad` }],
        },
      ]}
    />
  );
}

/**
 * The constellation being made (R3 E "Room sky"): seven fixed points on the night sky, the lit ones filled and joined by
 * straight lines, the rest small and hollow. Flat shapes and no sparkles. Each lit star is a button that says which moment
 * it was; an unlit one is only a mark. Stars appear in the order they were earned. The art is as wide as its column up to 288 px
 * and keeps its shape, so on a 320 px screen it neither overflows nor loses the edge of its last star.
 */
export function ConstellationView({
  lit,
  selected,
  onSelect,
  label,
}: {
  readonly lit: number;
  readonly selected: number | undefined;
  readonly onSelect: (index: number) => void;
  /** What a screen reader says of the whole drawing. */
  readonly label: string;
}) {
  const [width, setWidth] = useState(MAX_WIDTH);
  const measure = (event: LayoutChangeEvent) => {
    const measured = Math.round(event.nativeEvent.layout.width);
    if (measured > 0) setWidth(measured);
  };
  return (
    <View style={styles.sky} onLayout={measure} role="group" accessibilityLabel={label} testID="constellation">
      {Array.from({ length: Math.max(0, lit - 1) }, (_, index) => (
        <Segment key={index} from={index} to={index + 1} width={width} />
      ))}
      {CONSTELLATION_POINTS.map((_, index) => {
        const point = at(index, width);
        const on = index < lit;
        const frame = [styles.target, { left: point.x - TARGET / 2, top: point.y - TARGET / 2 }];
        const dot = [styles.dot, on ? styles.dotLit : styles.dotDim, selected === index ? styles.dotSelected : null];
        return on ? (
          <Pressable
            key={index}
            role="button"
            accessibilityLabel={`Star ${String(index + 1)} of 7`}
            onPress={() => onSelect(index)}
            style={frame}
            testID={`star-${String(index)}`}
          >
            <View style={dot} />
          </Pressable>
        ) : (
          <View key={index} aria-hidden style={frame} testID={`star-${String(index)}`}>
            <View style={dot} />
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  sky: {
    width: '100%',
    maxWidth: MAX_WIDTH,
    aspectRatio: 1 / ASPECT,
    alignSelf: 'center',
    borderRadius: 16,
    backgroundColor: space.s0,
  },
  line: { position: 'absolute', height: 2, backgroundColor: space.focus, opacity: 0.8 },
  target: { position: 'absolute', width: TARGET, height: TARGET, alignItems: 'center', justifyContent: 'center' },
  dot: { width: DOT, height: DOT, borderRadius: DOT / 2 },
  dotLit: { backgroundColor: space.focus, borderWidth: 2, borderColor: space.s0 },
  dotDim: { width: 10, height: 10, borderRadius: 5, borderWidth: 1.5, borderColor: space.label2 },
  dotSelected: { borderColor: space.label, borderWidth: 3 },
});
