import { Pressable, StyleSheet, View } from 'react-native';
import { CONSTELLATION_POINTS } from '@knowscroll/client-core';
import { space } from '@knowscroll/design-tokens';

const WIDTH = 288;
const HEIGHT = 168;
const TARGET = 44;
const DOT = 18;

const at = (index: number): { readonly x: number; readonly y: number } => {
  const [x, y] = CONSTELLATION_POINTS[index]!;
  return { x: x * WIDTH, y: y * HEIGHT };
};

/** A thin straight line between two lit stars, drawn as a turned strip centred on their midpoint. */
function Segment({ from, to }: { readonly from: number; readonly to: number }) {
  const first = at(from);
  const second = at(to);
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
 * it was; an unlit one is only a mark. Stars appear in the order they were earned.
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
  return (
    <View style={styles.sky} role="group" accessibilityLabel={label} testID="constellation">
      {Array.from({ length: Math.max(0, lit - 1) }, (_, index) => (
        <Segment key={index} from={index} to={index + 1} />
      ))}
      {CONSTELLATION_POINTS.map((_, index) => {
        const point = at(index);
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
    width: WIDTH,
    height: HEIGHT,
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
