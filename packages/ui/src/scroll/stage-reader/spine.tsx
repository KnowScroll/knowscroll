import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View, type ScrollViewInstance } from 'react-native';
import { content, spacing } from '@knowscroll/design-tokens';
import { useFocusRing } from '../../display/focus-ring';

/** What kind of place a dot stands for: a read stop, a call, the Final call, or the end of the Scroll. */
export type SpineDotKind = 'read' | 'call_it' | 'final_call' | 'end';

export interface SpineDot {
  readonly kind: SpineDotKind;
  /** What a screen reader says: "Stop 3 of 11", "Call it, 2 of 11", "Final call", "The end". */
  readonly label: string;
}

const SIZE = 12;
/** Height of one dot's target: the 24 px WCAG minimum, with a little air. */
const DOT_HEIGHT = 26;

function Mark({ kind, current }: { readonly kind: SpineDotKind; readonly current: boolean }) {
  const fill = current ? content.accent : content.paper;
  const base = { width: SIZE, height: SIZE, borderWidth: 2, borderColor: content.ink, backgroundColor: fill };
  if (kind === 'call_it') return <View style={[base, { transform: [{ rotate: '45deg' }] }]} />;
  if (kind === 'final_call')
    return (
      <View
        style={[
          base,
          styles.final,
          current ? { backgroundColor: content.accent } : { backgroundColor: content.continue },
        ]}
      />
    );
  if (kind === 'end') return <View style={[base, { borderRadius: 2 }]} />;
  return <View style={[base, { borderRadius: SIZE / 2 }]} />;
}

/**
 * The dots down the right edge: where the reader is, and a way to go anywhere (D-133). A dot per
 * stop, shaped by what it is (circle read, diamond call, star-ish square Final call, square end).
 * Tapping a dot jumps to it; each is a 28 px target in a list the keyboard tabs through. It shows
 * where you are among the stops and nothing else: no counts of anything read.
 */
export function Spine({
  dots,
  current,
  onJump,
}: {
  readonly dots: readonly SpineDot[];
  readonly current: number;
  readonly onJump: (index: number) => void;
}) {
  const scroller = useRef<ScrollViewInstance>(null);
  const [height, setHeight] = useState(0);
  // On a short screen the dots do not all fit: the list scrolls and keeps the dot you are on in view.
  useEffect(() => {
    scroller.current?.scrollTo({ y: Math.max(0, current * DOT_HEIGHT - (height - DOT_HEIGHT) / 2), animated: false });
  }, [current, height]);
  const fits = height >= dots.length * DOT_HEIGHT;
  return (
    <View role="navigation" accessibilityLabel="Where you are in this Scroll" style={styles.spine}>
      <ScrollView
        ref={scroller}
        onLayout={(event) => setHeight(event.nativeEvent.layout.height)}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={fits ? styles.centred : undefined}
        style={styles.list}
      >
        {dots.map((dot, index) => (
          <SpineButton key={index} dot={dot} current={index === current} onPress={() => onJump(index)} />
        ))}
      </ScrollView>
    </View>
  );
}

function SpineButton({
  dot,
  current,
  onPress,
}: {
  readonly dot: SpineDot;
  readonly current: boolean;
  readonly onPress: () => void;
}) {
  const focus = useFocusRing('onLight');
  return (
    <Pressable
      {...focus.props}
      accessibilityRole="button"
      accessibilityLabel={current ? `${dot.label}, you are here` : dot.label}
      aria-current={current ? 'step' : undefined}
      onPress={onPress}
      style={[styles.dot, focus.style]}
    >
      <Mark kind={dot.kind} current={current} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  spine: { width: 30, paddingVertical: spacing[1] },
  list: { flex: 1 },
  centred: { flexGrow: 1, justifyContent: 'center' },
  dot: { width: 30, height: DOT_HEIGHT, alignItems: 'center', justifyContent: 'center' },
  final: { borderRadius: 6 },
});
