import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { content, overlay, radius, space, spacing, target } from '@knowscroll/design-tokens';
import { IconButton, Text } from '@knowscroll/ui';
import { SpaceChip } from '../universe/space-chip';

/**
 * The visitor bar of U06: who is being visited, "Only what they share", Leave and Report. It is the first
 * thing on the screen so Leave is first in the tab order, and the banner under it is the same on
 * every visit for every person: it does not appear because something is hidden, so it cannot say
 * whether anything is.
 */
export function VisitorBar({
  ownerName,
  onLeave,
  onReport,
}: {
  readonly ownerName: string;
  readonly onLeave: () => void;
  /** Opens the report sheet about the owner. */
  readonly onReport: () => void;
}) {
  const [explaining, setExplaining] = useState(false);
  return (
    <View testID="visitor-bar" style={styles.root}>
      <View role="banner" style={styles.bar}>
        <View style={styles.avatar} aria-hidden importantForAccessibility="no-hide-descendants">
          <Text variant="ui" color={space.onControl}>
            {[...ownerName][0]?.toUpperCase() ?? ''}
          </Text>
        </View>
        <View style={styles.who}>
          <Text variant="ui" heading={1} color={space.label} numberOfLines={1}>
            {`Visiting ${ownerName}`}
          </Text>
          <Text variant="meta" color={space.label2} numberOfLines={1}>
            {`Only what ${ownerName} shares`}
          </Text>
        </View>
        <SpaceChip
          testID="visit-leave"
          variant="solid"
          label="Leave"
          accessibilityLabel="Leave this visit"
          onPress={onLeave}
        />
      </View>
      <View style={styles.banner}>
        <SpaceChip
          testID="visit-private-parts"
          icon="lock"
          label="Private parts stay private"
          toggled={explaining}
          onPress={() => setExplaining((open) => !open)}
        />
        <SpaceChip
          testID="visit-report"
          icon="alert"
          label="Report"
          accessibilityLabel={`Report ${ownerName}`}
          onPress={onReport}
        />
      </View>
      {explaining ? (
        <View testID="visit-private-card" role="dialog" accessibilityLabel="About private parts" style={styles.card}>
          <View style={styles.cardHeader}>
            <Text variant="title" heading={2}>
              Private parts stay private
            </Text>
            <IconButton icon="close" label="Close" variant="plain" onPress={() => setExplaining(false)} />
          </View>
          <Text variant="bodyS">
            {`You see only the systems ${ownerName} chose to share. The map doesn’t show where the rest are, how large they are, or whether there are any.`}
          </Text>
          <Text variant="bodyS" color={content.ink2}>
            The soft edge of the map looks the same on every visit, for everyone.
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: spacing[2] },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    minHeight: target.comfortable,
  },
  avatar: {
    width: target.minimum,
    height: target.minimum,
    borderRadius: radius.pill,
    backgroundColor: space.control,
    borderWidth: 1,
    borderColor: overlay.onDarkEdge,
    alignItems: 'center',
    justifyContent: 'center',
  },
  who: { flex: 1, minWidth: 0 },
  banner: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', gap: spacing[2] },
  card: {
    gap: spacing[2],
    padding: spacing[4],
    borderRadius: radius.card,
    backgroundColor: content.paper,
    maxWidth: 420,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing[2] },
});
