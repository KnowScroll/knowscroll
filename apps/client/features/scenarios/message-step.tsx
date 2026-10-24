import { StyleSheet, View } from 'react-native';
import type { ScenarioKind } from '@knowscroll/contracts';
import { content, spacing } from '@knowscroll/design-tokens';
import { Button, Text } from '@knowscroll/ui';

/** The words a message menu quotes: who said it and what it says (or what a snippet points at). */
export interface MessageQuote {
  readonly authorName: string;
  readonly preview: string;
}

/**
 * A message's menu (X01 entry point), the first step of the same sheet: What if… and Another perspective,
 * starting from this message or snippet. It is a step and not a sheet of its own, so choosing hands over
 * to the idea step without one overlay closing as another opens. Nothing is asked of the model until the
 * member writes their idea and continues, and nothing is made until they choose a direction.
 */
export function MessageStep({
  quote,
  onPick,
  onCancel,
}: {
  readonly quote: MessageQuote;
  readonly onPick: (kind: ScenarioKind) => void;
  readonly onCancel: () => void;
}) {
  return (
    <View style={styles.body}>
      <View style={styles.quote}>
        <Text variant="metaS" color={content.ink2}>
          {quote.authorName}
        </Text>
        <Text variant="bodyS" numberOfLines={4}>
          {quote.preview}
        </Text>
      </View>
      <Button label="What if…" variant="primary" fullWidth icon="hypothetical" onPress={() => onPick('what_if')} />
      <Button label="Another perspective" variant="default" fullWidth onPress={() => onPick('perspective')} />
      <Button label="Cancel" variant="ghost" fullWidth onPress={onCancel} />
    </View>
  );
}

const styles = StyleSheet.create({
  body: { gap: spacing[3] },
  quote: { gap: spacing[1], paddingLeft: spacing[3], borderLeftWidth: 3, borderLeftColor: content.accent },
});
