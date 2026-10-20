import { useRef } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { Text } from '@knowscroll/ui';
import { spacing, content } from '@knowscroll/design-tokens';
import { createGestureArbitrator } from './arbitration';

/** A dedicated navigation surface never claims a chart/slider/article pointer. All controls also have buttons. */
export function EncounterGestures({
  scroll,
  onMove,
}: {
  readonly scroll: boolean;
  readonly onMove: (move: 'next' | 'previous' | 'subject') => void;
}) {
  const gesture = useRef<ReturnType<typeof createGestureArbitrator> | null>(null);
  const origin = useRef({ x: 0, y: 0 });
  return (
    <View
      style={styles.zone}
      accessibilityLabel="Navigation gesture area"
      onTouchStart={(event) => {
        const { pageX, pageY } = event.nativeEvent;
        origin.current = { x: pageX, y: pageY };
        gesture.current = createGestureArbitrator({
          startX: pageX,
          scroll,
          childOwns: event.nativeEvent.touches.length !== 1,
          native: Platform.OS !== 'web',
        });
      }}
      onTouchMove={(event) => {
        if (event.nativeEvent.touches.length !== 1) gesture.current?.cancel();
        gesture.current?.move(event.nativeEvent.pageX - origin.current.x, event.nativeEvent.pageY - origin.current.y);
      }}
      onTouchCancel={() => {
        gesture.current?.cancel();
        gesture.current = null;
      }}
      onTouchEnd={() => {
        const move = gesture.current?.release();
        gesture.current = null;
        if (move) onMove(move);
      }}
    >
      <Text variant="meta" color={content.ink2}>
        {scroll
          ? 'Swipe here to continue the idea · buttons below'
          : 'Swipe here for a new subject or to continue · buttons below'}
      </Text>
    </View>
  );
}
const styles = StyleSheet.create({ zone: { minHeight: 44, justifyContent: 'center', paddingHorizontal: spacing[4] } });
