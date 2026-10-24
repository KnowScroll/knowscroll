import { Pressable, StyleSheet, View } from 'react-native';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { spaceActivates } from '../../display/space-key';
import { useFocusRing } from '../../display/focus-ring';
import { Text } from '../../text/text';

/**
 * "Text version of diagrams" (E03-4): one switch for the whole article. On, every visual block
 * (diagrams, charts, simulations, steppers) shows its words instead of its picture, and every
 * slider becomes a stepper. A real switch: role `switch`, checked state, Enter and Space.
 */
export function TextVersionToggle({
  on,
  onChange,
}: {
  readonly on: boolean;
  readonly onChange: (on: boolean) => void;
}) {
  const focus = useFocusRing('onLight');
  // The whole row is the switch: a target as tall as the row (52), not only the 32-high track.
  return (
    <Pressable
      {...focus.props}
      {...spaceActivates(() => onChange(!on))}
      accessibilityRole="switch"
      accessibilityLabel="Text version of diagrams"
      accessibilityState={{ checked: on }}
      aria-checked={on}
      onPress={() => onChange(!on)}
      style={[styles.row, focus.style]}
    >
      <Text variant="bodyS" style={styles.label}>
        Text version of diagrams
      </Text>
      <View style={[styles.track, on ? styles.trackOn : null]}>
        <View style={[styles.knob, on ? styles.knobOn : null]} />
      </View>
    </Pressable>
  );
}

const SWITCH_WIDTH = 56;
const SWITCH_HEIGHT = 32;
const KNOB = 22;

const styles = StyleSheet.create({
  row: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing[3],
    paddingHorizontal: spacing[3],
    borderRadius: radius.card,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.paper,
    cursor: 'pointer' as const,
  },
  label: { flex: 1, fontWeight: '600' },
  track: {
    width: SWITCH_WIDTH,
    height: SWITCH_HEIGHT,
    justifyContent: 'center',
    borderRadius: radius.pill,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.paper2,
  },
  trackOn: { backgroundColor: content.accent },
  knob: {
    width: KNOB,
    height: KNOB,
    marginLeft: 3,
    borderRadius: radius.pill,
    backgroundColor: content.ink,
  },
  knobOn: { marginLeft: SWITCH_WIDTH - KNOB - 3 - 2 * borderWidth.regular, backgroundColor: content.paper },
});
