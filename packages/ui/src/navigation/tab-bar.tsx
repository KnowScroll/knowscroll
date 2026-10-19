import { StyleSheet, View } from 'react-native';
import { content, dimension, elevation, radius, space, spacing } from '@knowscroll/design-tokens';
import { useDisplay } from '../display/display';
import { navigationContainerSemantics } from '../display/semantics';
import { DestinationItem } from './destination-item';
import { destinations, type Destination } from './destinations';

export interface TabBarProps {
  /** The current destination; `null` on screens that belong to none (the account stack). */
  readonly active: Destination | null;
  readonly onSelect: (destination: Destination) => void;
  /** `paper` (ink pill) on content screens, `space` on the universe. */
  readonly tone?: 'paper' | 'space';
  /** Talk has something unread (a description and a dot, never a count). */
  readonly unread?: boolean;
  /** The address of each destination; on the web the items become real links. */
  readonly hrefFor?: (destination: Destination) => string;
}

/**
 * The phone tab bar (NavBar.html): a floating pill, labels under icons. On compact phones
 * (≤ 360) the items are icon-only and the labels become their accessible names (V01). The pill
 * is positioned by the screen (the 96 px slot); this component draws only the pill.
 */
export function TabBar({ active, onSelect, tone = 'paper', unread = false, hrefFor }: TabBarProps) {
  const { breakpoint } = useDisplay();
  const compact = breakpoint === 'compact';
  return (
    <View
      {...navigationContainerSemantics('Primary')}
      style={[styles.pill, compact ? styles.pillCompact : null, tone === 'space' ? styles.space : styles.paper]}
    >
      {destinations.map((destination) => (
        <DestinationItem
          key={destination.id}
          id={destination.id}
          label={destination.label}
          icon={destination.icon}
          current={destination.id === active}
          unread={destination.id === 'conversations' && unread}
          showLabel={!compact}
          width={compact ? dimension.navItemCompact.width : dimension.navItem.width}
          height={compact ? dimension.navItemCompact.height : dimension.navItem.height}
          radius={compact ? dimension.navItemCompact.radius : radius.navItem}
          href={hrefFor?.(destination.id)}
          ground={tone === 'space' ? space.s1 : content.nav}
          onSelect={onSelect}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignSelf: 'center',
    gap: spacing[1],
    padding: spacing['1.5'],
    borderRadius: radius.navPill,
  },
  pillCompact: { padding: dimension.navPillCompactPadding, borderRadius: radius.navPillCompact },
  paper: { backgroundColor: content.nav, boxShadow: elevation.navPaper },
  space: { backgroundColor: space.s1, boxShadow: elevation.navSpace },
});
