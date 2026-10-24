import { useEffect, useRef } from 'react';
import { FlatList, Modal, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { RoomStation } from '@knowscroll/contracts';
import { borderWidth, content, dimension, layer, radius, spacing } from '@knowscroll/design-tokens';
import { Button, IconButton, Scrim, Text } from '@knowscroll/ui';
import { outlineRows, placeTrail, type OutlineRow, type UniverseIndex } from './universe-layout';
import type { UniverseMapSession, UniverseViewState } from './universe-session';

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
  label = 'Places in your universe',
  stations,
  onStation,
}: {
  readonly session: UniverseMapSession;
  readonly state: UniverseViewState;
  readonly index: UniverseIndex;
  readonly onChoose?: () => void;
  readonly label?: string;
  /** The room stations of this map: listed after the places, as the artboards' "Rooms" section does. */
  readonly stations?: readonly RoomStation[];
  readonly onStation?: (roomId: string) => void;
}) {
  const rows = outlineRows(index, state.lately);
  const list = useRef<FlatList<OutlineRow>>(null);
  const currentRow = rows.findIndex((row) => row.place.objectId === state.focusId);
  // Open on the place the person is looking at, so the outline answers "where am I".
  useEffect(() => {
    if (currentRow > 0) list.current?.scrollToIndex({ index: currentRow, viewPosition: 0.3, animated: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the list opens or the focus changes, not when Lately reorders it.
  }, [state.focusId]);
  const current = state.focusId ? index.byId.get(state.focusId) : undefined;
  const ancestors = new Set<string>();
  for (let place = current; place; place = index.byId.get(place.parentId)) ancestors.add(place.objectId);
  const renderRow = ({ item }: { item: OutlineRow }) => {
    const { place, depth } = item;
    const isCurrent = place.objectId === state.focusId;
    const trail = placeTrail(index, place);
    const name = [
      place.label,
      trail.length
        ? `${KIND_WORD[place.kind].toLowerCase()} in ${trail.join(', ')}`
        : KIND_WORD[place.kind].toLowerCase(),
      place.truthStatus === 'hypothetical' ? 'hypothetical' : undefined,
    ]
      .filter(Boolean)
      .join(', ');
    return (
      <View role="listitem">
        <Pressable
          testID={`universe-outline-${place.objectId}`}
          accessibilityRole="button"
          accessibilityLabel={name}
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
          <Text
            variant={depth === 0 ? 'title' : 'bodyS'}
            style={depth === 0 ? styles.systemName : null}
            {...(depth < 2 ? { heading: (depth + 2) as 2 | 3 } : {})}
          >
            {place.label}
          </Text>
          <Text variant="label" color={content.ink2}>
            {KIND_WORD[place.kind]}
          </Text>
        </Pressable>
      </View>
    );
  };
  return (
    <FlatList
      role="list"
      accessibilityLabel={label}
      ref={list}
      data={rows}
      getItemLayout={(_, position) => ({ length: ROW_HEIGHT, offset: ROW_HEIGHT * position, index: position })}
      keyExtractor={(row) => row.place.objectId}
      renderItem={renderRow}
      initialNumToRender={16}
      maxToRenderPerBatch={16}
      windowSize={7}
      style={styles.list}
      {...(stations && stations.length > 0
        ? { ListFooterComponent: <StationRows stations={stations} onStation={onStation} /> }
        : {})}
    />
  );
}

/** The "Rooms" section of the list view: each room station beside a system of this map, opening its room. */
function StationRows({
  stations,
  onStation,
}: {
  readonly stations: readonly RoomStation[];
  readonly onStation: ((roomId: string) => void) | undefined;
}) {
  return (
    <View role="group" accessibilityLabel="Rooms on your map" style={styles.rooms}>
      <Text variant="label" color={content.ink2} style={styles.roomsHeading}>
        Rooms
      </Text>
      {stations.map((station) => (
        <View key={station.room.roomId} role="listitem">
          <Pressable
            testID={`universe-outline-station-${station.room.roomId}`}
            accessibilityRole="button"
            accessibilityLabel={`${station.room.name}, a room station`}
            onPress={() => onStation?.(station.room.roomId)}
            style={[styles.row, styles.stationRow]}
          >
            <Text variant="bodyS">{station.room.name}</Text>
            <Text variant="label" color={content.ink2}>
              Room
            </Text>
          </Pressable>
        </View>
      ))}
    </View>
  );
}

/** The renderer's low-detail switch (U03 "Low detail"): flat silhouette and a plain list, same layout. */
export function DrawingToggle({
  session,
  state,
}: {
  readonly session: UniverseMapSession;
  readonly state: UniverseViewState;
}) {
  const simple = state.detail === 'low';
  return (
    <Button
      label="Simple drawing"
      size="sm"
      variant={simple ? 'ink' : 'default'}
      toggled={simple}
      onPress={() => session.configure({ detail: simple ? 'full' : 'low', reducedMotion: state.reducedMotion })}
    />
  );
}

/**
 * U02 / U08 "List view" as a sheet on phones: the same outline, with the Lately lens on top. Back
 * belongs to the Universe (hardware Back, Escape and browser Back all close it through the
 * session), so the sheet adds no history entry of its own that could undo the choice made in it.
 */
export function UniverseListSheet({
  session,
  state,
  index,
  owner,
  stations,
  onStation,
}: {
  readonly session: UniverseMapSession;
  readonly state: UniverseViewState;
  readonly index: UniverseIndex;
  readonly stations?: readonly RoomStation[];
  readonly onStation?: (roomId: string) => void;
  /** A friend's name: the sheet is theirs, and there is no Lately lens over a universe that is not yours. */
  readonly owner?: string;
}) {
  const insets = useSafeAreaInsets();
  const title = owner === undefined ? 'Your universe' : `${owner}’s universe`;
  return (
    <Modal
      visible
      transparent
      animationType="none"
      onRequestClose={() => {
        session.back();
      }}
    >
      <View style={styles.host}>
        <Scrim onPress={() => session.back()} testID="universe-list-scrim" />
        <View
          testID="universe-list-sheet"
          role="dialog"
          aria-label={title}
          accessibilityViewIsModal
          style={[styles.sheet, { paddingBottom: spacing[7] + insets.bottom }]}
        >
          <View style={styles.grab} aria-hidden importantForAccessibility="no-hide-descendants" />
          <View style={styles.sheetHeader}>
            <View style={styles.sheetTitle}>
              <Text variant="displayL" heading={2}>
                {title}
              </Text>
            </View>
            <IconButton icon="close" label="Close list view" onPress={() => session.back()} />
          </View>
          {owner === undefined ? (
            <View style={styles.lens}>
              <Text variant="bodyS" color={content.ink2} style={styles.lensText}>
                {state.lately
                  ? 'Lately on: places with recent activity come first in each group.'
                  : 'Every place, in order. Turn on Lately to see recent activity first.'}
              </Text>
              <Button
                label="Lately"
                size="sm"
                variant={state.lately ? 'ink' : 'default'}
                toggled={state.lately}
                onPress={() => session.setLately(!state.lately)}
              />
            </View>
          ) : null}
          <View style={styles.drawing}>
            <Text variant="bodyS" color={content.ink2} style={styles.lensText}>
              A flat drawing for slow devices. Every place stays where it is.
            </Text>
            <DrawingToggle session={session} state={state} />
          </View>
          <View style={styles.sheetList}>
            <OutlineList
              session={session}
              state={state}
              index={index}
              {...(stations ? { stations } : {})}
              {...(onStation ? { onStation } : {})}
              {...(owner === undefined ? {} : { label: `Places in ${owner}’s universe` })}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  host: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    zIndex: layer.sheet,
    gap: spacing['3.5'],
    backgroundColor: content.paper,
    borderTopWidth: borderWidth.regular,
    borderColor: content.ink,
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
    paddingHorizontal: spacing[5],
    paddingTop: spacing['2.5'],
    maxHeight: '85%',
    width: '100%',
    maxWidth: 560,
    alignSelf: 'center',
  },
  grab: {
    alignSelf: 'center',
    width: dimension.grabHandle.width,
    height: dimension.grabHandle.height,
    borderRadius: dimension.grabHandle.radius,
    backgroundColor: content.ink,
    opacity: 0.25,
  },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing[3] },
  sheetTitle: { flex: 1 },
  list: { flexGrow: 0 },
  sheetList: { maxHeight: 420 },
  drawing: { flexDirection: 'row', alignItems: 'center', gap: spacing[3], justifyContent: 'space-between' },
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
  rooms: { gap: spacing[1], paddingTop: spacing[3] },
  stationRow: { paddingLeft: spacing[3] },
  roomsHeading: { paddingHorizontal: spacing[3] },
  ancestor: { backgroundColor: content.paper2 },
  current: { backgroundColor: content.continue },
  systemName: { fontSize: 18, lineHeight: 24 },
});
