import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { useFocusRing } from '../../display/focus-ring';
import { Text } from '../../text/text';
import type { ForkBlock } from '../model';

function PathCard({
  label,
  chosen,
  onPress,
}: {
  readonly label: string;
  readonly chosen: boolean;
  readonly onPress: () => void;
}) {
  const focus = useFocusRing('onLight');
  return (
    <Pressable
      {...focus.props}
      accessibilityRole="button"
      accessibilityLabel={`Path: ${label}`}
      aria-pressed={chosen}
      onPress={onPress}
      style={[styles.card, chosen ? styles.cardChosen : null, focus.style]}
    >
      <Text variant="label" color={chosen ? content.paper : content.ink2}>
        A path
      </Text>
      <Text variant="ui" color={chosen ? content.paper : content.ink}>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * A fork (D-207): two paths, both written. The reader picks one and reads it; the other stays on the
 * page to pick afterwards, so nothing is missed and neither is needed to understand the next stop (they
 * rejoin there). The choice is the reader's own and is kept nowhere: it is no signal about them
 * (D-063, D-209). The text version shows both paths at once.
 */
export function ForkBody({ fork, asText }: { readonly fork: ForkBlock; readonly asText: boolean }) {
  const [chosen, setChosen] = useState<number | undefined>(undefined);
  if (asText)
    return (
      <View style={styles.body} testID="fork-text">
        <Text variant="title" heading={3}>
          {fork.prompt}
        </Text>
        {fork.branches.map((branch) => (
          <Text key={branch.label} variant="body">
            {`${branch.label}: ${branch.text}`}
          </Text>
        ))}
      </View>
    );
  const branch = chosen === undefined ? undefined : fork.branches[chosen];
  return (
    <View style={styles.body}>
      <Text variant="title" heading={3}>
        {fork.prompt}
      </Text>
      <View style={styles.cards}>
        {fork.branches.map((candidate, index) => (
          <PathCard
            key={candidate.label}
            label={candidate.label}
            chosen={chosen === index}
            onPress={() => setChosen(index)}
          />
        ))}
      </View>
      <View accessibilityLiveRegion="polite" role="status">
        {branch === undefined ? (
          <Text variant="meta" color={content.ink2}>
            Pick a path. The other one stays here to read afterwards, and both meet again below.
          </Text>
        ) : (
          <View style={styles.read} testID="fork-branch">
            <Text variant="label" color={content.ink2}>
              {branch.label}
            </Text>
            <Text variant="body">{branch.text}</Text>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { gap: spacing[3] },
  cards: { flexDirection: 'row', gap: spacing[2] },
  card: {
    flex: 1,
    minHeight: 64,
    gap: spacing[1],
    padding: spacing[3],
    borderRadius: radius.card,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.paper,
    justifyContent: 'center',
  },
  cardChosen: { backgroundColor: content.ink },
  read: {
    gap: spacing[1],
    padding: spacing[3],
    borderRadius: radius.card,
    borderWidth: borderWidth.regular,
    borderStyle: 'dashed',
    borderColor: content.ink,
    backgroundColor: content.paper2,
  },
});
