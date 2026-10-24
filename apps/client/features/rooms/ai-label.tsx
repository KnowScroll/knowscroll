import { StyleSheet, View } from 'react-native';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { Icon, Text } from '@knowscroll/ui';

/**
 * The label an AI inhabitant always carries ("AI · Skeptic"). It is a dark pill with words, so it
 * never relies on colour alone, and the screen-reader name says "AI, Skeptic" before any content.
 * The text comes from the server (the role's fixed label); a client cannot show an inhabitant
 * without it.
 */
export function AiLabel({ label, testID }: { readonly label: string; readonly testID?: string }) {
  return (
    <View
      testID={testID}
      accessible
      accessibilityRole="text"
      accessibilityLabel={label.replace(/\s·\s/g, ', ')}
      style={styles.pill}
    >
      <Text variant="label" color={content.paper}>
        {label}
      </Text>
    </View>
  );
}

/** The moderator's mark: a shield and the word. A moderator is a person, never an AI. */
export function ModeratorLabel() {
  return (
    <View accessible accessibilityRole="text" accessibilityLabel="Moderator" style={styles.moderator}>
      <Icon name="shield" size={12} color={content.freshInk} />
      <Text variant="label" color={content.freshInk}>
        Moderator
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    alignSelf: 'flex-start',
    minHeight: 26,
    justifyContent: 'center',
    paddingHorizontal: spacing['2.5'],
    borderRadius: radius.pill,
    backgroundColor: content.ink,
  },
  moderator: {
    alignSelf: 'flex-start',
    minHeight: 26,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing['1.5'],
    paddingHorizontal: spacing['2.5'],
    borderRadius: radius.pill,
    borderWidth: borderWidth.light,
    borderColor: content.freshInk,
    backgroundColor: content.paper,
  },
});
