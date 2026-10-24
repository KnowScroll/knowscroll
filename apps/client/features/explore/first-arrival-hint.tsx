import { StyleSheet, View } from 'react-native';
import { borderWidth, content, elevation, radius, spacing } from '@knowscroll/design-tokens';
import { Button, Icon, Text, type IconName } from '@knowscroll/ui';

export interface HintLine {
  readonly icon: IconName;
  readonly text: string;
}

function Line({ icon, text }: HintLine) {
  return (
    <View style={styles.line}>
      <Icon name={icon} size={18} />
      <Text variant="ui" style={styles.lineText}>
        {text}
      </Text>
    </View>
  );
}

/**
 * A03: how to move around, once, with no survey. The yellow offset shadow is the one place the
 * export draws yellow on a hint. "Got it" is a real button so the note can be dismissed from a
 * keyboard or a screen reader.
 */
export function FirstArrivalHint({
  lead,
  lines,
  footnote,
  onDismiss,
}: {
  readonly lead?: string;
  readonly lines: readonly HintLine[];
  readonly footnote: string;
  readonly onDismiss: () => void;
}) {
  return (
    <View role="note" accessibilityLabel="How to move around" style={styles.card}>
      {lead === undefined ? null : (
        <Text variant="uiS" color={content.ink2}>
          {lead}
        </Text>
      )}
      {lines.map((line) => (
        <Line key={line.text} {...line} />
      ))}
      <Text variant="meta" color={content.ink2}>
        {footnote}
      </Text>
      <Button label="Got it" variant="ink" size="sm" onPress={onDismiss} />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: spacing['2.5'],
    padding: spacing[4],
    borderRadius: radius.edgeTab,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.paper,
    boxShadow: elevation.hint,
    alignItems: 'flex-start',
  },
  line: { flexDirection: 'row', alignItems: 'center', gap: spacing['1.5'] },
  lineText: { flexShrink: 1 },
});
