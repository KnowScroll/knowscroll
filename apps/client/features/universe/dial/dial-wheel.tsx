import { useEffect, useState, type ReactNode } from 'react';
import { PanResponder, Platform, StyleSheet, View, type LayoutChangeEvent, type ViewProps } from 'react-native';

/** What a turning finger needs to know about the wheel it turns. */
interface Turn {
  readonly chosen: number;
  readonly count: number;
  readonly gap: number;
  readonly onChoose: (index: number) => void;
  readonly onTurn: ((turning: boolean) => void) | undefined;
}

/**
 * The horizontal drag that turns a wheel. It keeps the latest `Turn` (props change under a finger) and
 * reports the fractional place while turning; on release it chooses the nearest one.
 */
function createTurnGesture(setTurned: (position: number | null) => void) {
  let latest: Turn | undefined;
  let start = 0;
  const clamp = (position: number) => Math.min(latest!.count - 1, Math.max(0, position));
  const responder = PanResponder.create({
    onMoveShouldSetPanResponderCapture: (_, gesture) =>
      Math.abs(gesture.dx) > 8 && Math.abs(gesture.dx) > Math.abs(gesture.dy),
    onPanResponderGrant: () => {
      start = latest!.chosen;
      latest!.onTurn?.(true);
    },
    onPanResponderMove: (_, gesture) => setTurned(clamp(start - gesture.dx / latest!.gap)),
    onPanResponderRelease: (_, gesture) => {
      latest!.onChoose(Math.round(clamp(start - gesture.dx / latest!.gap)));
      setTurned(null);
      latest!.onTurn?.(false);
    },
    onPanResponderTerminate: () => {
      setTurned(null);
      latest!.onTurn?.(false);
    },
  });
  return {
    responder,
    update: (next: Turn) => {
      latest = next;
    },
  };
}

/**
 * A row that turns: items sit along a line with the chosen one in the middle, and a horizontal drag
 * turns it like a dial. Letting go chooses the nearest item, so the wheel always rests on one. A
 * tap on an item is the item's own press, so it works without any gesture (and by keyboard and
 * screen reader, which the items provide).
 */
export function Wheel({
  count,
  chosen,
  gap,
  height,
  onChoose,
  onTurn,
  renderItem,
  testID,
  label,
}: {
  readonly count: number;
  /** The index at rest in the middle. */
  readonly chosen: number;
  /** Pixels between two neighbours. */
  readonly gap: number;
  readonly height: number;
  readonly onChoose: (index: number) => void;
  /** A finger is turning the wheel. */
  readonly onTurn?: (turning: boolean) => void;
  /** `distance` is how many places the item is from the middle, fractional while turning. */
  readonly renderItem: (index: number, distance: number) => ReactNode;
  readonly testID?: string;
  /** What the wheel is a wheel of, for a screen reader. */
  readonly label: string;
}) {
  const [width, setWidth] = useState(390);
  const [turned, setTurned] = useState<number | null>(null);
  const [gesture] = useState(() => createTurnGesture(setTurned));
  useEffect(() => gesture.update({ chosen, count, gap, onChoose, onTurn }));
  const position = turned ?? chosen;
  // Left and right arrow turn the wheel one place (the keyboard map lists them).
  const onKeyDown: NonNullable<ViewProps['onKeyDown']> = (event) => {
    if (!('key' in event.nativeEvent)) return;
    const key = event.nativeEvent.key;
    const next = key === 'ArrowLeft' ? chosen - 1 : key === 'ArrowRight' ? chosen + 1 : undefined;
    if (next === undefined || next < 0 || next >= count) return;
    event.preventDefault();
    onChoose(next);
  };
  return (
    <View
      testID={testID}
      role="group"
      accessibilityLabel={label}
      {...(Platform.OS === 'web' ? { onKeyDown } : {})}
      style={[styles.wheel, { height }]}
      onLayout={(event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width)}
      {...gesture.responder.panHandlers}
    >
      {Array.from({ length: count }, (_, index) => {
        const distance = Math.abs(index - position);
        // Items far past the edge of the row are not drawn: they could not be seen or reached.
        if (distance * gap > width / 2 + gap) return null;
        return (
          <View
            key={index}
            style={[styles.slot, { left: width / 2 + (index - position) * gap, height }]}
            pointerEvents="box-none"
          >
            {renderItem(index, distance)}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wheel: { width: '100%', overflow: 'hidden' },
  slot: { position: 'absolute', top: 0, width: 0, alignItems: 'center', justifyContent: 'center' },
});
