import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import {
  borderWidth,
  content,
  elevation,
  opacity,
  pressOffset,
  radius,
  space,
  spacing,
  status,
  target,
  type FocusTone,
} from '@knowscroll/design-tokens';
import { useDisplay } from '../display/display';
import { useFocusRing } from '../display/focus-ring';
import { linkPress } from '../display/link';
import { linkSemantics, toggleSemantics } from '../display/semantics';
import { Spinner } from '../feedback/spinner';
import { Icon } from '../icons/icon';
import type { IconName } from '../icons/icon-paths';
import { Text } from '../text/text';

/**
 * Authored variants (Components.html): primary, default, ink, ghost, space. Drawn in the frames
 * and named here: danger (D05), continue (continuation only, D-006 b).
 */
export type ButtonVariant = 'primary' | 'default' | 'ink' | 'ghost' | 'space' | 'danger' | 'continue';
export type ButtonSize = 'md' | 'sm';

interface VariantStyle {
  readonly background: string;
  readonly foreground: string;
  readonly border: string;
  readonly shadow: boolean;
  readonly focus: FocusTone;
}

const variants: Record<ButtonVariant, VariantStyle> = {
  primary: {
    background: content.accent,
    foreground: content.onAccent,
    border: content.ink,
    shadow: true,
    focus: 'onLight',
  },
  default: { background: content.paper, foreground: content.ink, border: content.ink, shadow: true, focus: 'onLight' },
  ink: { background: content.ink, foreground: content.paper, border: content.ink, shadow: false, focus: 'onLight' },
  ghost: { background: 'transparent', foreground: content.ink, border: content.ink, shadow: false, focus: 'onLight' },
  space: {
    background: space.control,
    foreground: space.onControl,
    border: space.control,
    shadow: false,
    focus: 'onDark',
  },
  danger: {
    background: status.danger.fill,
    foreground: content.paper,
    border: status.danger.fill,
    shadow: true,
    focus: 'onLight',
  },
  continue: {
    background: content.continue,
    foreground: content.onContinue,
    border: content.ink,
    shadow: true,
    focus: 'onLight',
  },
};

export interface ButtonProps {
  readonly label: string;
  readonly onPress?: () => void;
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly icon?: IconName;
  readonly iconPosition?: 'leading' | 'trailing';
  readonly disabled?: boolean;
  /** A command in flight: the spinner arc and a verb-ing label replace the label; presses are ignored. */
  readonly busy?: boolean;
  readonly busyLabel?: string;
  readonly accessibilityHint?: string;
  /** `link` for buttons that navigate (an `<a>` in the export). */
  readonly role?: 'button' | 'link';
  /** For links: the address. On the web the button becomes a real `<a href>` (Enter, new tab). */
  readonly href?: string;
  /** Stretch across the parent even where the parent does not stretch its children. */
  readonly fullWidth?: boolean;
  /** A two-state button (Like, Save in the large-text grid): announced as pressed or not. */
  readonly toggled?: boolean;
  /** The surface the button sits on decides the focus-ring colour (D-006 n). */
  readonly surface?: 'light' | 'dark';
  readonly testID?: string;
}

/**
 * The pill button. States: default · pressed (travels by its 3 px offset shadow, which goes to
 * 0; under reduced motion it loses the shadow without travelling) · focus-visible (3 px ring,
 * 3 px offset) · disabled (45 %, no shadow) · busy (`aria-busy`, spinner and "…ing" label).
 */
export function Button({
  label,
  onPress,
  variant = 'default',
  size = 'md',
  icon,
  iconPosition = 'leading',
  disabled = false,
  busy = false,
  busyLabel,
  accessibilityHint,
  role = 'button',
  href,
  fullWidth = false,
  toggled,
  surface,
  testID,
}: ButtonProps) {
  const look = variants[variant];
  const { reducedMotion } = useDisplay();
  const focus = useFocusRing(surface === undefined ? look.focus : surface === 'dark' ? 'onDark' : 'onLight');
  const inert = disabled || busy;
  const shown = busy ? (busyLabel ?? label) : label;
  const iconSize = size === 'md' ? 18 : 16;
  const navigation =
    role === 'link' && onPress !== undefined && !inert ? linkPress({ href, onNavigate: onPress }) : undefined;
  const iconElement = busy ? (
    <Spinner size={iconSize} color={look.foreground} />
  ) : icon === undefined ? null : (
    <Icon name={icon} size={iconSize} color={look.foreground} />
  );

  return (
    <Pressable
      {...focus.props}
      testID={testID}
      onPress={inert ? undefined : onPress}
      {...navigation}
      disabled={disabled}
      // Busy and disabled buttons take no presses at all (a busy command is never sent twice).
      pointerEvents={inert ? 'none' : 'auto'}
      {...(role === 'link' ? linkSemantics(href !== undefined) : { accessibilityRole: 'button' as const })}
      {...(toggled === undefined ? {} : toggleSemantics(toggled))}
      accessibilityLabel={shown}
      accessibilityHint={accessibilityHint}
      aria-disabled={disabled}
      aria-busy={busy}
      style={({ pressed }) => {
        const pressedNow = pressed && !inert;
        const frame: ViewStyle[] = [
          styles.base,
          size === 'md' ? styles.md : styles.sm,
          { backgroundColor: look.background, borderColor: look.border },
        ];
        if (fullWidth) frame.push(styles.fullWidth);
        if (look.shadow && !pressedNow && !disabled) frame.push(styles.shadow);
        if (pressedNow && look.shadow && !reducedMotion) frame.push(styles.travelled);
        if (disabled) frame.push(styles.disabled);
        if (focus.style !== undefined) frame.push(focus.style);
        return frame;
      }}
    >
      {iconPosition === 'leading' ? iconElement : null}
      <View style={styles.label}>
        <Text variant={size === 'md' ? 'ui' : 'uiS'} color={look.foreground} align="center">
          {shown}
        </Text>
      </View>
      {iconPosition === 'trailing' ? iconElement : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[2],
    borderWidth: borderWidth.regular,
    borderRadius: radius.pill,
    cursor: 'pointer' as const,
  },
  md: { minHeight: target.comfortable, paddingHorizontal: spacing[5] },
  sm: { minHeight: target.minimum, paddingHorizontal: spacing['3.5'] },
  fullWidth: { alignSelf: 'stretch' },
  shadow: { boxShadow: elevation.press },
  travelled: { transform: [{ translateX: pressOffset }, { translateY: pressOffset }] },
  disabled: { opacity: opacity.disabled, cursor: 'auto' as const },
  label: { flexShrink: 1 },
});
