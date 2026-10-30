import { StyleSheet, View } from 'react-native';
import { reactorNames } from '@knowscroll/client-core';
import type { MessageReactionKind, PublicPersonRef } from '@knowscroll/contracts';
import { content, spacing } from '@knowscroll/design-tokens';
import { BottomSheet, Button, REACTION_LABELS, ReactionGlyph, Text } from '@knowscroll/ui';

/**
 * "Tap to see who" (T3 kit): the people behind one reaction on one message, "You" first, and one
 * button to add yours or take it back. It names only the people the reader may see (the server left out
 * anyone they blocked) and carries no time.
 */
export function ReactorSheet({
  kind,
  people,
  ownPersonId,
  mine,
  onToggle,
  onClose,
}: {
  readonly kind: MessageReactionKind | undefined;
  readonly people: readonly PublicPersonRef[];
  readonly ownPersonId: string | undefined;
  readonly mine: boolean;
  readonly onToggle: () => void;
  readonly onClose: () => void;
}) {
  const label = kind === undefined ? '' : REACTION_LABELS[kind];
  return (
    <BottomSheet visible={kind !== undefined} title={`${label} · ${String(people.length)}`} onClose={onClose}>
      <View style={styles.body}>
        <View role="list" accessibilityLabel={`People who reacted with ${label}`} style={styles.people}>
          {reactorNames(people, ownPersonId).map((name, index) => (
            <View key={`${name}-${String(index)}`} role="listitem" style={styles.person}>
              {kind === undefined ? null : <ReactionGlyph kind={kind} size={20} />}
              <Text variant="ui" color={content.ink}>
                {name}
              </Text>
            </View>
          ))}
        </View>
        <Button
          label={mine ? `Take back your ${label}` : `Add your ${label}`}
          variant={mine ? 'default' : 'primary'}
          fullWidth
          onPress={() => {
            onToggle();
            onClose();
          }}
          testID="reactor-toggle"
        />
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  body: { gap: spacing[3], paddingBottom: spacing[2] },
  people: { gap: spacing[2] },
  person: { flexDirection: 'row', alignItems: 'center', gap: spacing[3], minHeight: 44 },
});
