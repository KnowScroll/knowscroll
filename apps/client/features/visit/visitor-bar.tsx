import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { content, radius, spacing, target } from '@knowscroll/design-tokens';
import { Button, IconButton, Text, useFocusRing } from '@knowscroll/ui';
import { SpaceChip } from '../universe/space-chip';

const PAPER = '#FFFDF2';
const INK = '#15302A';
const INK2 = 'rgba(21,48,42,0.7)';
/** The orange of the visited person's initial (U06). */
const ORANGE = '#FF8A5C';

/**
 * The visitor bar of U06: one cream pill with Leave first (dark), who is being visited and "Only what they
 * share", and the person's initial on the right, which opens the options (Report). It is the first thing on
 * the screen so Leave is first in the tab order, and it is the same on every visit for every person: it does
 * not appear because something is hidden, so it cannot say whether anything is.
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
  const [options, setOptions] = useState(false);
  const leaveFocus = useFocusRing('onLight');
  const optionsFocus = useFocusRing('onLight');
  return (
    <View testID="visitor-bar" style={styles.root}>
      <View role="banner" style={styles.pill}>
        <Pressable
          testID="visit-leave"
          accessibilityRole="button"
          accessibilityLabel="Leave this visit"
          onPress={onLeave}
          {...leaveFocus.props}
          style={[styles.leave, leaveFocus.style]}
        >
          <Text variant="ui" color={PAPER}>
            Leave
          </Text>
        </Pressable>
        <View style={styles.who}>
          <Text variant="ui" heading={1} color={INK} numberOfLines={1}>
            {`Visiting ${ownerName}’s universe`}
          </Text>
          <Text variant="meta" color={INK2} numberOfLines={1}>
            {`Only what ${ownerName} shares`}
          </Text>
        </View>
        <Pressable
          testID="visit-options"
          accessibilityRole="button"
          accessibilityLabel={`Options for ${ownerName}`}
          aria-expanded={options}
          onPress={() => setOptions((open) => !open)}
          {...optionsFocus.props}
          style={[styles.avatar, optionsFocus.style]}
        >
          <Text variant="ui" color={content.ink}>
            {[...ownerName][0]?.toUpperCase() ?? ''}
          </Text>
        </Pressable>
      </View>
      {options ? (
        <View
          testID="visit-options-card"
          role="dialog"
          accessibilityLabel={`Options for ${ownerName}`}
          style={styles.card}
        >
          <View style={styles.cardHeader}>
            <Text variant="title" heading={2}>
              {ownerName}
            </Text>
            <IconButton icon="close" label="Close" variant="plain" onPress={() => setOptions(false)} />
          </View>
          <View style={styles.cardActions}>
            <Button
              testID="visit-report"
              label="Report"
              icon="alert"
              variant="ghost"
              accessibilityLabel={`Report ${ownerName}`}
              onPress={() => {
                setOptions(false);
                onReport();
              }}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

/**
 * The one lock chip at the bottom of the visit (U06): "Private parts stay private", which opens the same
 * explanation on every visit, so it never says whether anything is hidden.
 */
export function VisitorPrivacy({ ownerName }: { readonly ownerName: string }) {
  const [explaining, setExplaining] = useState(false);
  return (
    <View testID="visitor-privacy" style={styles.privacy}>
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
      <SpaceChip
        testID="visit-private-parts"
        icon="lock"
        label="Private parts stay private"
        toggled={explaining}
        onPress={() => setExplaining((open) => !open)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: spacing[2] },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    minHeight: 60,
    paddingHorizontal: spacing[2],
    borderRadius: radius.pill,
    backgroundColor: PAPER,
  },
  leave: {
    minHeight: target.minimum,
    justifyContent: 'center',
    paddingHorizontal: spacing[5],
    borderRadius: radius.pill,
    backgroundColor: INK,
    cursor: 'pointer' as const,
  },
  who: { flex: 1, minWidth: 0 },
  avatar: {
    width: target.minimum,
    height: target.minimum,
    borderRadius: radius.pill,
    backgroundColor: ORANGE,
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer' as const,
  },
  privacy: { gap: spacing[2], alignItems: 'flex-start' },
  card: {
    gap: spacing[2],
    padding: spacing[4],
    borderRadius: radius.card,
    backgroundColor: content.paper,
    maxWidth: 420,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing[2] },
  cardActions: { flexDirection: 'row', gap: spacing[2] },
});
