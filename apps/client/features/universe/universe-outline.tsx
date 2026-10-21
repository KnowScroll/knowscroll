import { useEffect, type ReactNode } from 'react';
import { FlatList, Modal, Platform, StyleSheet, View } from 'react-native';
import { Button, Text, useDisplay } from '@knowscroll/ui';
import { content, overlay, spacing } from '@knowscroll/design-tokens';
import type { UniverseViewSession } from './universe-session';

/** One modal host, with no separate history owner. Universe Back owns this overlay. */
export function UniversePanel({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  const { breakpoint } = useDisplay();
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const previous = document.activeElement;
    const panel = document.querySelector<HTMLElement>('[data-testid="universe-panel"]');
    const controls = () => panel?.querySelectorAll<HTMLElement>('button, a[href], input, [tabindex="0"]');
    controls()?.[0]?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const nodes = controls();
      if (!nodes?.length) return;
      const first = nodes[0]!,
        last = nodes[nodes.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', trap);
    return () => {
      document.removeEventListener('keydown', trap);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return (
    <Modal visible transparent animationType="none" onRequestClose={close}>
      <View style={[styles.host, breakpoint === 'desktop' ? styles.docked : null]}>
        <View
          testID="universe-panel"
          role="dialog"
          accessibilityLabel={title}
          accessibilityViewIsModal
          style={styles.panel}
        >
          <Text variant="displayL" heading={2}>
            {title}
          </Text>
          <Button label="Close" onPress={close} />
          {children}
        </View>
      </View>
    </Modal>
  );
}
export function UniverseOutline({ session }: { session: UniverseViewSession }) {
  const places = session.places();
  return (
    <UniversePanel title="Universe outline" close={() => session.back()}>
      <FlatList
        style={styles.list}
        data={places}
        keyExtractor={(p) => p.id}
        initialNumToRender={12}
        maxToRenderPerBatch={12}
        windowSize={5}
        accessibilityLabel="Established places"
        renderItem={({ item }) => {
          const parent = places.find((p) => p.id === item.parentId);
          return (
            <View style={styles.row}>
              <Button label={`${item.label} · ${item.kind}`} onPress={() => session.focus(item.id)} />
              <Text variant="meta">
                {parent ? `In ${parent.label}. ` : ''}
                {item.truthStatus === 'hypothetical' ? 'Hypothetical.' : ''}
              </Text>
            </View>
          );
        }}
      />
    </UniversePanel>
  );
}
const styles = StyleSheet.create({
  host: { flex: 1, justifyContent: 'flex-end', backgroundColor: overlay.scrim },
  docked: { alignItems: 'flex-end', justifyContent: 'center' },
  panel: {
    backgroundColor: content.paper,
    padding: spacing[5],
    gap: spacing[3],
    width: '100%',
    maxWidth: 560,
    maxHeight: '85%',
  },
  list: { height: 360 },
  row: { paddingVertical: spacing[2], gap: spacing[1] },
});
