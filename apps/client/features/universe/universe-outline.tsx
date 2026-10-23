import { useEffect, useRef } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { content, radius, spacing } from '@knowscroll/design-tokens';
import { BottomSheet, Button, Text } from '@knowscroll/ui';
import { outlineRows, type OutlineRow, type UniverseIndex } from './universe-layout';
import type { UniverseViewSession, UniverseViewState } from './universe-session';

const ROW_HEIGHT = 52;
const KIND_WORD = { system: 'System', star: 'Star', planet: 'Planet', region: 'Region' } as const;

/**
 * The accessible outline of the map (U02 and U08 "List view", D02's side panel): every place, in
 * order, each a 48 px row that flies there. It is the screen-reader primary view and the way to
 * reach anything the drawing cannot show.
 */
export function OutlineList({
  session,
  state,
  index,
  onChoose,
}: {
  readonly session: UniverseViewSession;
  readonly state: UniverseViewState;
  readonly index: UniverseIndex;
  readonly onChoose?: () => void;
}) {
  const rows = outlineRows(index, state.lately);
  const list = useRef<FlatList<OutlineRow>>(null);
  const currentRow = rows.findIndex((row) => row.place.objectId === state.focusId);
  // Open on the place the person is looking at, so the outline answers "where am I".
  useEffect(() => {
    if (currentRow > 0) list.current?.scrollToIndex({ index: currentRow, viewPosition: 0.3, animated: false });
    // Only when the list opens or the focus changes, not when Lately reorders it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.focusId]);
  const current = state.focusId ? index.byId.get(state.focusId) : undefined;
  const ancestors = new Set<string>();
  for (let place = current; place; place = index.byId.get(place.parentId)) ancestors.add(place.objectId);
  const renderRow = ({ item }: { item: OutlineRow }) => {
    const { place, depth } = item;
    const isCurrent = place.objectId === state.focusId;
    return (
      <Pressable
        testID={`universe-outline-${place.objectId}`}
        accessibilityRole="button"
        accessibilityLabel={`${place.label}, ${KIND_WORD[place.kind].toLowerCase()}${place.truthStatus === 'hypothetical' ? ', hypothetical' : ''}`}
        accessibilityState={{ selected: isCurrent }}
        onPress={() => {
          session.focus(place.objectId);
          onChoose?.();
        }}
        style={[
          styles.row,
          { paddingLeft: spacing[3] + depth * spacing[5] },
          ancestors.has(place.objectId) ? styles.ancestor : null,
          isCurrent ? styles.current : null,
        ]}
      >
        <Text variant={depth === 0 ? 'title' : 'bodyS'} style={depth === 0 ? styles.systemName : null}>
          {place.label}
        </Text>
        <Text variant="label" color={content.ink2}>
          {KIND_WORD[place.kind]}
        </Text>
      </Pressable>
    );
  };
  return (
    <FlatList
      accessibilityLabel="Places in your universe"
      ref={list}
      data={rows}
      getItemLayout={(_, position) => ({ length: ROW_HEIGHT, offset: ROW_HEIGHT * position, index: position })}
      keyExtractor={(row) => row.place.objectId}
      renderItem={renderRow}
      initialNumToRender={16}
      maxToRenderPerBatch={16}
      windowSize={7}
      style={styles.list}
    />
  );
}

/** U02 / U08 "List view" as a sheet on phones: the same outline, with the Lately lens on top. */
export function UniverseListSheet({
  session,
  state,
  index,
}: {
  readonly session: UniverseViewSession;
  readonly state: UniverseViewState;
  readonly index: UniverseIndex;
}) {
  return (
    <BottomSheet visible title="Your universe" closeLabel="Close list view" onClose={() => session.back()} testID="universe-list-sheet">
      <View style={styles.lens}>
        <Text variant="bodyS" color={content.ink2} style={styles.lensText}>
          {state.lately
            ? 'Lately on: places with recent activity come first in each group.'
            : 'Every place, in order. Turn on Lately to see recent activity first.'}
        </Text>
        <Button label="Lately" size="sm" variant={state.lately ? 'ink' : 'default'} toggled={state.lately} onPress={() => session.setLately(!state.lately)} />
      </View>
      <View style={styles.sheetList}>
        <OutlineList session={session} state={state} index={index} />
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  list: { flexGrow: 0 },
  sheetList: { maxHeight: 420 },
  lens: { flexDirection: 'row', alignItems: 'center', gap: spacing[3], justifyContent: 'space-between' },
  lensText: { flex: 1 },
  row: {
    height: ROW_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing[3],
    paddingRight: spacing[3],
    borderRadius: radius.md,
    cursor: 'pointer' as const,
  },
  ancestor: { backgroundColor: content.paper2 },
  current: { backgroundColor: content.continue },
  systemName: { fontSize: 18, lineHeight: 24 },
});
