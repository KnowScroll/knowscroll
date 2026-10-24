import { StyleSheet, View } from 'react-native';
import type { ScenarioKind } from '@knowscroll/contracts';
import { content, layout, spacing } from '@knowscroll/design-tokens';
import { Button } from '@knowscroll/ui';

/** The two ways to ask, between the messages and the message box (X01 entry point: the whole thread). */
export function AsksBar({ onAsk }: { readonly onAsk: (kind: ScenarioKind) => void }) {
  return (
    <View style={styles.asks} accessibilityLabel="Explore other possibilities">
      <Button
        label="What if…"
        size="sm"
        variant="ghost"
        icon="hypothetical"
        onPress={() => onAsk('what_if')}
        testID="ask-what-if"
      />
      <Button
        label="Another perspective"
        size="sm"
        variant="ghost"
        onPress={() => onAsk('perspective')}
        testID="ask-perspective"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  asks: {
    flexDirection: 'row',
    gap: spacing[2],
    flexWrap: 'wrap',
    paddingHorizontal: layout.gutter,
    paddingVertical: spacing[2],
    backgroundColor: content.paper2,
  },
});
