import { Pressable, StyleSheet, type ViewStyle } from 'react-native';
import { borderWidth, content, opacity, overlay, radius, target, type FocusTone } from '@knowscroll/design-tokens';
import { useFocusRing } from '../display/focus-ring';
import { toggleSemantics } from '../display/semantics';
import { Spinner } from '../feedback/spinner';
import { Icon } from '../icons/icon';
import { fillWhenPressed, type IconName } from '../icons/icon-paths';

/**
 * `paper`: 2 px ink edge on paper. `onMedia` / `onSpace`: borderless cream at 94 % over media or
 * the map. `plain`: no edge (Scroll top-bar Back). `accent`: Send.
 */
export type IconButtonVariant = 'paper' | 'onMedia' | 'onSpace' | 'plain' | 'accent';

const looks: Record<IconButtonVariant, { background: string; border: string; foreground: string; focus: FocusTone }> = {
  paper: { background: content.paper, border: content.ink, foreground: content.ink, focus: 'onLight' },
  onMedia: { background: overlay.onMediaControl, border: 'transparent', foreground: content.ink, focus: 'onDark' },
  onSpace: { background: overlay.onMediaControl, border: 'transparent', foreground: content.ink, focus: 'onDark' },
  plain: { background: 'transparent', border: 'transparent', foreground: content.ink, focus: 'onLight' },
  accent: { background: content.accent, border: content.ink, foreground: content.onAccent, focus: 'onLight' },
};

export interface IconButtonProps {
  readonly icon: IconName;
  /** The accessible name; icons are never the name (for Back say where it goes: "Back to Keep"). */
  readonly label: string;
  readonly onPress?: () => void;
  readonly variant?: IconButtonVariant;
  /** 48 by default; 44 for compact and landscape layouts. Never smaller (D-006 n). */
  readonly size?: 48 | 44;
  /** A two-state control (Like, Save): pressed fills yellow and the glyph fills. */
  readonly pressed?: boolean;
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly accessibilityHint?: string;
  /** Override the colour of the icon (for example cream on an ink surface). */
  readonly color?: string;
  readonly testID?: string;
}

export function IconButton({
  icon,
  label,
  onPress,
  variant = 'paper',
  size = target.comfortable,
  pressed,
  disabled = false,
  busy = false,
  accessibilityHint,
  color,
  testID,
}: IconButtonProps) {
  const look = looks[variant];
  const focus = useFocusRing(look.focus);
  const toggle = pressed === undefined ? { accessibilityRole: 'button' as const } : toggleSemantics(pressed);
  const inert = disabled || busy;
  const foreground = color ?? look.foreground;
  return (
    <Pressable
      {...focus.props}
      {...toggle}
      testID={testID}
      onPress={inert ? undefined : onPress}
      disabled={disabled}
      pointerEvents={inert ? 'none' : 'auto'}
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      aria-disabled={disabled}
      aria-busy={busy}
      style={({ pressed: down }) => {
        const frame: ViewStyle[] = [
          styles.base,
          {
            width: size,
            height: size,
            backgroundColor: pressed === true ? content.continue : look.background,
            borderColor: look.border,
          },
        ];
        if (down && !inert) frame.push(styles.down);
        if (disabled) frame.push(styles.disabled);
        if (focus.style !== undefined) frame.push(focus.style);
        return frame;
      }}
    >
      {busy ? (
        <Spinner size={20} color={foreground} />
      ) : (
        <Icon name={icon} size={22} color={foreground} filled={pressed === true && fillWhenPressed.has(icon)} />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: radius.pill,
    borderWidth: borderWidth.regular,
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer' as const,
  },
  down: { opacity: 0.85 },
  disabled: { opacity: opacity.disabled, cursor: 'auto' as const },
});
