import { useId } from 'react';
import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import { content, overlay, spacing } from '@knowscroll/design-tokens';
import { useFocusRing } from '../display/focus-ring';
import { describedByElement, descriptionSemantics, destinationSemantics } from '../display/semantics';
import { Icon } from '../icons/icon';
import { Text } from '../text/text';
import { unreadDescription, type Destination } from './destinations';

export interface DestinationItemProps {
  readonly id: Destination;
  readonly label: string;
  readonly icon: Parameters<typeof Icon>[0]['name'];
  readonly current: boolean;
  readonly unread: boolean;
  readonly showLabel: boolean;
  readonly width: number;
  readonly height: number;
  readonly radius: number;
  readonly onSelect: (id: Destination) => void;
}

/**
 * One destination in the tab bar or the rail. The accessible name is always the plain label
 * ("Talk"); unread is a separate description, never part of the name (D-006 n). Visually it is
 * the export's "Talk •", or a cream dot on the icon where labels are hidden (never yellow, which
 * means continuation only).
 */
export function DestinationItem({
  id,
  label,
  icon,
  current,
  unread,
  showLabel,
  width,
  height,
  radius,
  onSelect,
}: DestinationItemProps) {
  const focus = useFocusRing('onDark');
  const descriptionId = `ks-unread-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const foreground = current ? content.onAccent : overlay.onDarkMuted;
  return (
    <Pressable
      {...focus.props}
      {...destinationSemantics(current)}
      {...descriptionSemantics(unread ? unreadDescription : undefined, descriptionId)}
      accessibilityLabel={label}
      onPress={() => onSelect(id)}
      testID={`destination-${id}`}
      style={() => {
        const frame: ViewStyle[] = [styles.item, { width, minHeight: height, borderRadius: radius }];
        if (current) frame.push(styles.current);
        if (focus.style !== undefined) frame.push(focus.style);
        return frame;
      }}
    >
      <View>
        <Icon name={icon} size={22} color={foreground} />
        {unread && !showLabel ? (
          <View
            style={[styles.dot, { backgroundColor: foreground, borderColor: current ? content.accent : content.nav }]}
          />
        ) : null}
      </View>
      {showLabel ? (
        <Text variant="uiLabel" color={foreground} align="center" numberOfLines={1}>
          {unread ? `${label} •` : label}
        </Text>
      ) : null}
      {unread && describedByElement ? (
        <View nativeID={descriptionId} style={styles.hidden}>
          <Text variant="uiLabel">{unreadDescription}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  item: { alignItems: 'center', justifyContent: 'center', gap: spacing[1], cursor: 'pointer' as const },
  current: { backgroundColor: content.accent },
  dot: {
    position: 'absolute',
    top: -2,
    right: -4,
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 2,
  },
  hidden: { position: 'absolute', width: 1, height: 1, overflow: 'hidden', opacity: 0 },
});
