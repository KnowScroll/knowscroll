import { useMemo, type ReactNode } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import type { RoomStation } from '@knowscroll/contracts';
import { content, spacing } from '@knowscroll/design-tokens';
import {
  Button,
  dialogHostSemantics,
  dialogSemantics,
  IconButton,
  SwitchRow,
  Text,
  usePageInert,
} from '@knowscroll/ui';
import { SystemSections } from './simple/system-sections';
import { listUniverse } from './universe-lists';
import type { UniverseIndex } from './universe-layout';
import { UniverseSearchPanel } from './universe-search-panel';
import type { UniverseMapSession, UniverseViewState } from './universe-session';

/** An on-demand modal over the full-sized map; mounting it never resizes the camera's viewport. */
function MapDialog({
  title,
  onClose,
  children,
  testID,
}: {
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly testID: string;
}) {
  usePageInert(true);
  return (
    <Modal {...dialogHostSemantics(title)} transparent animationType="none" onRequestClose={onClose}>
      <View style={styles.host}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessible={false} focusable={false} />
        <View {...dialogSemantics(title)} testID={testID} style={styles.panel}>
          <View style={styles.head}>
            <Text variant="heading" heading={2}>
              {title}
            </Text>
            <IconButton icon="close" label={`Close ${title}`} variant="plain" onPress={onClose} />
          </View>
          <ScrollView
            style={styles.list}
            contentContainerStyle={styles.listContent}
            keyboardShouldPersistTaps="handled"
          >
            {children}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

/** Search and the complete accessible outline share one Browse surface, including selected-place and collection actions. */
export function UniversePanel({
  session,
  state,
  index,
  stations,
  owner,
  card,
  collection,
  onStation,
}: {
  readonly session: UniverseMapSession;
  readonly state: UniverseViewState;
  readonly index: UniverseIndex;
  readonly stations?: readonly RoomStation[];
  /** Visits never receive private regions, Lately, collection or rooms. */
  readonly owner?: string;
  readonly card: ReactNode;
  readonly collection?: ReactNode;
  readonly onStation?: (roomId: string) => void;
}) {
  const listed = useMemo(
    () => listUniverse(index, owner === undefined ? (stations ?? []) : [], state.youWereHere, state.lately),
    [index, stations, owner, state.youWereHere, state.lately],
  );
  return (
    <MapDialog title="Browse" testID="universe-panel" onClose={() => session.back()}>
      <UniverseSearchPanel
        session={session}
        {...(owner ? { owner } : {})}
        {...(owner === undefined && stations ? { stations } : {})}
        {...(onStation ? { onStation } : {})}
        embedded
      >
        <View>
          {card}
          {collection}
          <SystemSections
            session={session}
            listed={listed}
            visitor={owner !== undefined}
            pickedId={state.selectedId}
            onSystem={(id) => session.focus(id)}
            {...(onStation ? { onStation } : {})}
          />
        </View>
      </UniverseSearchPanel>
    </MapDialog>
  );
}

/** Uses the session's existing account-scoped preference writes; fallback is effective state, not a saved preference. */
export function UniverseSettings({
  session,
  state,
  simple,
  visitor,
  onSimple,
}: {
  readonly session: UniverseMapSession;
  readonly state: UniverseViewState;
  readonly simple: boolean;
  readonly visitor: boolean;
  readonly onSimple: (on: boolean) => void;
}) {
  return (
    <MapDialog title="Settings" testID="universe-settings-panel" onClose={() => session.back()}>
      {visitor ? null : <SwitchRow label="Lately" on={state.lately} onChange={(on) => session.setLately(on)} />}
      <SwitchRow label="Simple drawing" on={simple} onChange={onSimple} />
      <Button label="Return to map" onPress={() => session.back()} />
    </MapDialog>
  );
}

const styles = StyleSheet.create({
  host: { flex: 1, alignItems: 'flex-end', backgroundColor: 'rgba(2,3,8,0.35)' },
  panel: {
    width: 420,
    maxWidth: '100%',
    height: '100%',
    backgroundColor: content.paper,
    padding: spacing[5],
    gap: spacing[3],
  },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing[2] },
  list: { flex: 1 },
  listContent: { paddingBottom: spacing[6] },
});
