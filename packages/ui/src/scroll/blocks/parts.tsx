import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { content, spacing } from '@knowscroll/design-tokens';
import { Button } from '../../actions/button';
import { Banner } from '../../status/banner';
import { Text } from '../../text/text';

/** The small mono label above a block's content ("Two ways to read"). */
export function BlockLabel({ children }: { readonly children: string }) {
  return (
    <Text variant="label" color={content.ink2}>
      {children}
    </Text>
  );
}

/** The block's own title line ("Try a longer sentence"). */
export function BlockTitle({ children }: { readonly children: string }) {
  return (
    <Text variant="ui" style={styles.title}>
      {children}
    </Text>
  );
}

/** A row of the block's own actions (Reset, Describe this diagram). */
export function BlockActions({ children }: { readonly children: ReactNode }) {
  return <View style={styles.actions}>{children}</View>;
}

/** Back to the block's authored start. Disabled when the block is already there. */
export function ResetButton({ onPress, disabled }: { readonly onPress: () => void; readonly disabled: boolean }) {
  return <Button label="Reset" size="sm" icon="retry" disabled={disabled} onPress={onPress} />;
}

/**
 * Shown when a new revision of the article changed what a block's state means, so the reader's
 * earlier setting started over (E03: "revision changed, state reset with notice").
 */
export function ResetNotice({ onDismiss }: { readonly onDismiss: () => void }) {
  return (
    <Banner
      kind="info"
      lead="Updated."
      message="This changed in a newer version of the Scroll, so your earlier setting started over."
      action={{ label: 'Got it', onPress: onDismiss }}
    />
  );
}

const styles = StyleSheet.create({
  title: { fontWeight: '600' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing[2] },
});
