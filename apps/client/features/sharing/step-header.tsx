import { StyleSheet, View } from 'react-native';
import { content, spacing } from '@knowscroll/design-tokens';
import { IconButton, Text } from '@knowscroll/ui';

/** The top of a share step (H01): a plain Back arrow and the step's name. */
export function StepHeader({
  title,
  onBack,
  backDisabled,
}: {
  readonly title: string;
  readonly onBack: () => void;
  readonly backDisabled: boolean;
}) {
  return (
    <View style={styles.header}>
      <IconButton icon="back" label="Back" variant="plain" disabled={backDisabled} onPress={onBack} />
      <Text variant="title" heading={2}>
        {title}
      </Text>
    </View>
  );
}

/** The small caps line above a group of people ("RECENT"). */
export function GroupLabel({ children }: { readonly children: string }) {
  return (
    <Text variant="monoXs" color={content.ink2}>
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
});
