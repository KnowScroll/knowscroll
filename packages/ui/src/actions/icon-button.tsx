import { Pressable, StyleSheet, type ViewStyle } from 'react-native';
import {
  borderWidth,
  content,
  opacity,
  overlay,
  radius,
  target,
  toggle,
  type FocusTone,
} from '@knowscroll/design-tokens';
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
  /**
   * A two-state control (Like, Save). Pressed is never yellow (continuation only, D-006 b as
   * amended): filled cobalt with a filled cream glyph on paper; filled cream with a filled ink
   * glyph over media and the map.
   */
  readonly pressed?: boolean;
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly accessibilityHint?: string;
  /** Override the colour of the icon (for example cream on an ink surface). */
  readonly color?: string;
  readonly testID?: string;
  /** The control gained or lost focus (for a screen that draws it only while it can be found by pointer or keyboard). */
  readonly onFocus?: () => void;
  readonly onBlur?: () => void;
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
  onFocus,
  onBlur,
}: IconButtonProps) {
  const look = looks[variant];
  const focus = useFocusRing(look.focus);
  const toggleProps = pressed === undefined ? { accessibilityRole: 'button' as const } : toggleSemantics(pressed);
  const inert = disabled || busy;
  const pressedLook = look.focus === 'onDark' ? toggle.pressedOnDark : toggle.pressedOnLight;
  const isPressed = pressed === true;
  const foreground = isPressed ? pressedLook.foreground : (color ?? look.foreground);
  return (
    <Pressable
      {...focus.props}
      onFocus={() => {
        focus.props.onFocus();
        onFocus?.();
      }}
      onBlur={() => {
        focus.props.onBlur();
        onBlur?.();
      }}
      {...toggleProps}
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
            backgroundColor: isPressed ? pressedLook.background : look.background,
            borderColor: isPressed ? pressedLook.edge : look.border,
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
        <Icon name={icon} size={22} color={foreground} filled={isPressed && fillWhenPressed.has(icon)} />
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
