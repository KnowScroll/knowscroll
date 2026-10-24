import { Pressable, StyleSheet, View } from 'react-native';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { useFocusRing } from '../display/focus-ring';
import { spaceActivates } from '../display/space-key';
import { Text } from '../text/text';

const SWITCH_WIDTH = 56;
const SWITCH_HEIGHT = 32;
const KNOB = 22;

/** The track and knob of a switch (P02 `.sw`): cobalt when on, sunken paper when off. */
export function SwitchTrack({ on }: { readonly on: boolean }) {
  return (
    <View style={[styles.track, on ? styles.trackOn : null]} aria-hidden>
      <View style={[styles.knob, on ? styles.knobOn : null]} />
    </View>
  );
}

export interface SwitchRowProps {
  /** The setting's name; it is also the switch's accessible name. */
  readonly label: string;
  /** What the setting does, in a line a person already understands. */
  readonly description?: string;
  readonly on: boolean;
  readonly onChange: (on: boolean) => void;
  /** Read-only while a change is on its way or the setting cannot be changed now. */
  readonly disabled?: boolean;
}

/**
 * A setting that is on or off (P02, P01 accessibility): the name and what it does on the left, the
 * switch on the right. The whole row is the switch, a target as tall as the row; role `switch`,
 * checked state, Enter and Space.
 */
export function SwitchRow({ label, description, on, onChange, disabled = false }: SwitchRowProps) {
  const focus = useFocusRing('onLight');
  return (
    <Pressable
      {...focus.props}
      {...spaceActivates(() => {
        if (!disabled) onChange(!on);
      })}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: on, disabled }}
      aria-checked={on}
      disabled={disabled}
      onPress={() => onChange(!on)}
      style={[styles.row, disabled ? styles.disabled : null, focus.style]}
    >
      <View style={styles.words}>
        <Text variant="bodyS" style={styles.label}>
          {label}
        </Text>
        {description === undefined ? null : (
          <Text variant="meta" color={content.ink2}>
            {description}
          </Text>
        )}
      </View>
      <SwitchTrack on={on} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing[3],
    paddingVertical: spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: content.rule,
    cursor: 'pointer' as const,
  },
  disabled: { opacity: 0.6 },
  words: { flex: 1, minWidth: 0, gap: 2 },
  label: { fontWeight: '700' },
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
