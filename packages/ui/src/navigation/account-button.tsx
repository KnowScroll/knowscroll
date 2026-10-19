import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import { avatar, borderWidth, content, radius, target, type FocusTone } from '@knowscroll/design-tokens';
import { useFocusRing } from '../display/focus-ring';
import { linkPress } from '../display/link';
import { currentPageSemantics, linkSemantics } from '../display/semantics';
import { Icon } from '../icons/icon';
import { Text } from '../text/text';

export interface AccountButtonProps {
  readonly onPress: () => void;
  /** The account address; on the web the avatar is a real `<a href>`. */
  readonly href?: string;
  /** The signed-in person's initial; without one (signed out) the button shows a person glyph. */
  readonly initial?: string;
  /** The account screen is showing (the rail marks it current). */
  readonly current?: boolean;
  /** 48 in headers; the desktop rail draws 40 inside a 48 target. */
  readonly size?: 48 | 40;
  readonly surface?: 'light' | 'dark';
}

/**
 * The avatar that opens Account and settings from every tab header (D-006 c) and from the
 * bottom of the desktop rail.
 */
export function AccountButton({
  onPress,
  href,
  initial,
  current = false,
  size = 48,
  surface = 'light',
}: AccountButtonProps) {
  const tone: FocusTone = surface === 'dark' ? 'onDark' : 'onLight';
  const focus = useFocusRing(tone);
  return (
    <Pressable
      {...focus.props}
      {...linkSemantics(href !== undefined)}
      accessibilityLabel="Account and settings"
      {...currentPageSemantics(current)}
      {...linkPress({ href, onNavigate: onPress })}
      testID="account-button"
      style={() => {
        const frame: ViewStyle[] = [styles.target];
        if (focus.style !== undefined) frame.push(focus.style);
        return frame;
      }}
    >
      <View
        style={[
          styles.avatar,
          { width: size, height: size },
          size === 40 ? styles.borderless : null,
          current ? styles.current : null,
        ]}
      >
        {initial === undefined ? (
          <Icon name="person" size={size === 48 ? 22 : 20} color={avatar.onSelf} />
        ) : (
          <Text variant="ui" color={avatar.onSelf}>
            {initial.slice(0, 1).toUpperCase()}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  target: {
    minWidth: target.comfortable,
    minHeight: target.comfortable,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
    cursor: 'pointer' as const,
  },
  avatar: {
    borderRadius: radius.pill,
    borderWidth: borderWidth.regular,
    borderColor: avatar.edge,
    backgroundColor: avatar.self,
    alignItems: 'center',
    justifyContent: 'center',
  },
  borderless: { borderWidth: 0 },
  current: { borderWidth: 3, borderColor: content.paper },
});
