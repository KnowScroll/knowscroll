import type { ReactNode } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { content, overlay } from '@knowscroll/design-tokens';

/** Native modal owns accessibility focus and routes system Back to the same local overlay path. */
export function EncounterOverlay({
  children,
  onClose,
  label = 'Your path',
  presentation = 'full',
}: {
  readonly children: ReactNode;
  readonly label?: string;
  readonly presentation?: 'full' | 'sheet';
  readonly onClose: () => void;
}) {
  return (
    <Modal
      testID="encounter-overlay-modal"
      visible
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View
        style={[styles.host, presentation === 'sheet' ? styles.sheetHost : undefined]}
        role="dialog"
        aria-modal
        accessibilityViewIsModal
        accessibilityLabel={label}
      >
        {presentation === 'sheet' ? (
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={onClose}
            accessible={false}
            importantForAccessibility="no"
            focusable={false}
          />
        ) : null}
        {children}
      </View>
    </Modal>
  );
}
const styles = StyleSheet.create({
  host: { flex: 1, backgroundColor: content.paper },
  sheetHost: { backgroundColor: overlay.scrim },
});
