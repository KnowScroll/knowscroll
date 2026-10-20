import type { ReactNode } from 'react';
import { Modal, StyleSheet, View } from 'react-native';
import { content } from '@knowscroll/design-tokens';

/** Native modal owns accessibility focus and routes system Back to the same local overlay path. */
export function EncounterOverlay({
  children,
  onClose,
  label = 'Your path',
}: {
  readonly children: ReactNode;
  readonly label?: string;
  readonly onClose: () => void;
}) {
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.host} accessibilityViewIsModal accessibilityLabel={label}>
        {children}
      </View>
    </Modal>
  );
}
const styles = StyleSheet.create({ host: { flex: 1, backgroundColor: content.paper } });
