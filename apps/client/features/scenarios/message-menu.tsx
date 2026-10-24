import { StyleSheet, View } from 'react-native';
import type { ScenarioKind } from '@knowscroll/contracts';
import { content, spacing } from '@knowscroll/design-tokens';
import { BottomSheet, Button, Text } from '@knowscroll/ui';

/**
 * A message's menu (X01 entry point): What if… and Another perspective, starting from this message
 * or snippet. Choosing one opens the sheet; nothing is asked of the model until the member writes
 * their idea and continues, and nothing is made until they choose a direction.
 */
export function MessageMenu({
  visible,
  authorName,
  preview,
  onAsk,
  onClose,
}: {
  readonly visible: boolean;
  readonly authorName: string;
  /** The words of the message, or a short description of the snippet. */
  readonly preview: string;
  readonly onAsk: (kind: ScenarioKind) => void;
  readonly onClose: () => void;
}) {
  return (
    <BottomSheet visible={visible} title="From this message" onClose={onClose}>
      <View style={styles.body}>
        <View style={styles.quote}>
          <Text variant="metaS" color={content.ink2}>
            {authorName}
          </Text>
          <Text variant="bodyS" numberOfLines={4}>
            {preview}
          </Text>
        </View>
        <Button label="What if…" variant="primary" fullWidth icon="hypothetical" onPress={() => onAsk('what_if')} />
        <Button label="Another perspective" variant="default" fullWidth onPress={() => onAsk('perspective')} />
        <Button label="Cancel" variant="ghost" fullWidth onPress={onClose} />
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  body: { gap: spacing[3] },
  quote: { gap: spacing[1], paddingLeft: spacing[3], borderLeftWidth: 3, borderLeftColor: content.accent },
});
