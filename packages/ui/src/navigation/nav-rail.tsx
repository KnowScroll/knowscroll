import { StyleSheet, View } from 'react-native';
import { borderWidth, content, layout, radius, space, spacing } from '@knowscroll/design-tokens';
import { navigationContainerSemantics } from '../display/semantics';
import { Text } from '../text/text';
import { AccountButton } from './account-button';
import { DestinationItem } from './destination-item';
import { destinations, type Destination } from './destinations';

export interface NavRailProps {
  readonly active: Destination | null;
  readonly onSelect: (destination: Destination) => void;
  /** Tablet (600–1023): 76 px. Desktop (≥ 1024): 88 px with the K mark and the account avatar. */
  readonly size: 'tablet' | 'desktop';
  /** The space tone adds the cream hairline against the map (D02). */
  readonly tone?: 'paper' | 'space';
  readonly unread?: boolean;
  /** Desktop only: the account avatar at the bottom of the rail. */
  readonly account?: { readonly onPress: () => void; readonly current: boolean; readonly initial?: string };
}

/** The ink navigation rail of tablets and desktops (V01 `.tnav`, D01–D05 `.rnav`). */
export function NavRail({ active, onSelect, size, tone = 'paper', unread = false, account }: NavRailProps) {
  const desktop = size === 'desktop';
  return (
    <View
      style={[
        styles.rail,
        { width: desktop ? layout.railDesktop : layout.railTablet, paddingVertical: desktop ? spacing[5] : spacing[7] },
        tone === 'space' ? styles.spaceEdge : null,
      ]}
    >
      {desktop ? (
        <View
          style={styles.mark}
          aria-hidden
          importantForAccessibility="no-hide-descendants"
          accessibilityElementsHidden
        >
          <Text variant="title" color={content.continue}>
            K
          </Text>
        </View>
      ) : null}
      <View {...navigationContainerSemantics('Primary')} style={styles.items}>
        {destinations.map((destination) => (
          <DestinationItem
            key={destination.id}
            id={destination.id}
            label={destination.label}
            icon={destination.icon}
            current={destination.id === active}
            unread={destination.id === 'conversations' && unread}
            showLabel
            width={desktop ? 72 : 60}
            height={desktop ? 64 : 60}
            radius={desktop ? radius.edgeTab : radius.lg}
            onSelect={onSelect}
          />
        ))}
      </View>
      {desktop && account !== undefined ? (
        <View style={styles.account}>
          <AccountButton
            onPress={account.onPress}
            current={account.current}
            initial={account.initial}
            size={40}
            surface="dark"
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  rail: { alignItems: 'center', backgroundColor: content.nav, gap: spacing[2], alignSelf: 'stretch' },
  spaceEdge: { borderRightWidth: borderWidth.hairline, borderRightColor: space.orbit },
  mark: { marginBottom: spacing['3.5'] },
  items: { alignItems: 'center', gap: spacing[2] },
  account: { marginTop: 'auto' },
});
