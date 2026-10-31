import { useMemo, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import type { RoomStation } from '@knowscroll/contracts';
import { spacing } from '@knowscroll/design-tokens';
import { SwitchRow, Text, useFocusRing } from '@knowscroll/ui';
import { SIMPLE } from './simple/place-rows';
import { SystemSections } from './simple/system-sections';
import { countOf, listUniverse } from './universe-lists';
import type { UniverseIndex } from './universe-layout';
import type { UniverseMapSession, UniverseViewState } from './universe-session';

/**
 * D02's panel (378 px, always open from 1024 px): the title with its counts, the search field, the
 * picked place's card docked at the top, the two switches, and every system with its planets and
 * the rooms. It reads the same lists as the Simple view, so the two cannot disagree. It is the
 * screen-reader view of the whole map: every system and planet is a button, and the regions are one
 * Land away.
 */
export function UniversePanel({
  session,
  state,
  index,
  stations,
  owner,
  simple,
  card,
  onSearch,
  onSimple,
  onStation,
}: {
  readonly session: UniverseMapSession;
  readonly state: UniverseViewState;
  readonly index: UniverseIndex;
  readonly stations?: readonly RoomStation[];
  /** A friend's name: the panel is theirs, with no Lately, no rooms and no region lines. */
  readonly owner?: string;
  /** Simple drawing is showing the lists, by the setting or because 3D failed. */
  readonly simple: boolean;
  /** The card of the picked place, docked above the switches. */
  readonly card: ReactNode;
  readonly onSearch: () => void;
  readonly onSimple: (simple: boolean) => void;
  readonly onStation?: (roomId: string) => void;
}) {
  const listed = useMemo(
    () => listUniverse(index, owner === undefined ? (stations ?? []) : [], state.youWereHere, state.lately),
    [index, stations, owner, state.youWereHere, state.lately],
  );
  const planets = listed.systems.reduce((sum, system) => sum + system.planets.length, 0);
  const focus = state.focusId ? index.byId.get(state.focusId) : undefined;
  const hereSystemId = focus?.kind === 'system' ? focus.objectId : focus ? systemOf(index, focus.objectId) : undefined;
  const subject = owner === undefined ? 'your universe' : `${owner}’s universe`;
  const searchFocus = useFocusRing('onLight');
  return (
    <View role="complementary" aria-label="Outline" testID="universe-panel" style={styles.panel}>
      <View style={styles.head}>
        <Text variant="heading" heading={2} color={SIMPLE.ink} style={styles.title}>
          {owner === undefined ? 'Your universe' : `${owner}’s universe`}
        </Text>
        <Text variant="meta" color={SIMPLE.ink2} align="right" style={styles.counts}>
          {`${countOf(listed.systems.length, 'system')} · ${countOf(planets, 'planet')}`}
        </Text>
      </View>
      <Pressable
        testID="universe-panel-search"
        accessibilityRole="button"
        accessibilityLabel={`Search ${subject}`}
        onPress={onSearch}
        {...searchFocus.props}
        style={[styles.search, searchFocus.style]}
      >
        <Text variant="bodyS" color={SIMPLE.ink2} style={styles.searchText}>
          {`Search ${subject}`}
        </Text>
        <View style={styles.slash} aria-hidden>
          <Text variant="metaS" color={SIMPLE.ink2}>
            /
          </Text>
        </View>
      </Pressable>
      {card ? <View style={styles.card}>{card}</View> : null}
      <View style={styles.switches}>
        {owner === undefined ? (
          <SwitchRow label="Lately" on={state.lately} onChange={(on) => session.setLately(on)} />
        ) : null}
        <SwitchRow label="Simple drawing" on={simple} onChange={onSimple} />
      </View>
      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        <SystemSections
          session={session}
          listed={listed}
          visitor={owner !== undefined}
          hereSystemId={hereSystemId ?? null}
          pickedId={state.selectedId}
          {...(onStation ? { onStation } : {})}
        />
      </ScrollView>
    </View>
  );
}

/** The system a planet or region belongs to. */
function systemOf(index: UniverseIndex, placeId: string): string | undefined {
  for (let place = index.byId.get(placeId); place; place = index.byId.get(place.parentId))
    if (place.kind === 'system') return place.objectId;
  return undefined;
}

const styles = StyleSheet.create({
  panel: { width: 378, backgroundColor: '#FFFBF0', paddingTop: spacing[6], paddingHorizontal: spacing[5] },
  head: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: spacing[3] },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    minHeight: 48,
    marginTop: spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: SIMPLE.line,
  },
  title: { flexShrink: 0 },
  counts: { flexShrink: 1 },
  searchText: { flex: 1 },
  slash: {
    paddingHorizontal: spacing[2],
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: SIMPLE.line,
  },
  card: { marginTop: spacing[3] },
  switches: { marginTop: spacing[2] },
  list: { flex: 1 },
  listContent: { paddingBottom: spacing[6] },
});
