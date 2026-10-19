import { StyleSheet, View } from 'react-native';
import { content, elevation, radius, space, spacing } from '@knowscroll/design-tokens';
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
}

/**
 * The phone tab bar (NavBar.html): a floating pill, labels under icons. On compact phones
 * (≤ 360) the items are icon-only and the labels become their accessible names (V01). The pill
 * is positioned by the screen (the 96 px slot); this component draws only the pill.
 */
export function TabBar({ active, onSelect, tone = 'paper', unread = false }: TabBarProps) {
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
          width={compact ? 56 : 74}
          height={compact ? 48 : 56}
          radius={compact ? 18 : radius.navItem}
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
  pillCompact: { padding: 5, borderRadius: 24 },
  paper: { backgroundColor: content.nav, boxShadow: elevation.navPaper },
  space: { backgroundColor: space.s1, boxShadow: elevation.navSpace },
});
