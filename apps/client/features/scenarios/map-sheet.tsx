import { ScrollView, StyleSheet, TextInput, View, useWindowDimensions } from 'react-native';
import type { MapFilter, MapRow, MapView } from '@knowscroll/client-core';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { BottomSheet, Button, Icon, Text, useTypeStyle } from '@knowscroll/ui';
import { MapLine } from './map-rows';

/** A map this big (branches and suggestions) offers search and the filter; a small one is just its outline. */
export const LARGE_MAP = 6;

const FILTERS: readonly { readonly filter: MapFilter; readonly label: string }[] = [
  { filter: 'mine', label: 'Mine' },
  { filter: 'everyone', label: 'Everyone' },
  { filter: 'suggestions', label: 'Suggestions' },
];

const EMPTY: Record<NonNullable<MapView['empty']>, string> = {
  none: 'Nothing has branched from this thread yet.',
  search: 'No branch matches that.',
  filter: 'Nothing here for this filter.',
};

/** Branches and suggestions in a view: what makes a map "large" (X04). */
export const sizeOf = (rows: readonly MapRow[]): number =>
  rows.filter((row) => row.kind === 'branch' || row.kind === 'suggestion').length;

/**
 * X04: the map of this thread, an outline of the original sequence with its branches nested where they grew, as
 * an overlay (closing it returns to where the member was; jumping opens the branch). Search and the filter
 * appear once the map is large. It draws what exists and nothing it has to invent: no canvas, no counts.
 */
export function MapSheet({
  visible,
  view,
  large,
  filter,
  query,
  onFilter,
  onQuery,
  onClose,
  onOpenEpisode,
  onOpenBranch,
  onOpenOffer,
  onShowMore,
}: {
  readonly visible: boolean;
  readonly view: MapView;
  readonly large: boolean;
  readonly filter: MapFilter;
  readonly query: string;
  readonly onFilter: (filter: MapFilter) => void;
  readonly onQuery: (query: string) => void;
  readonly onClose: () => void;
  readonly onOpenEpisode: (assetId: string) => void;
  readonly onOpenBranch: (nodeId: string) => void;
  readonly onOpenOffer: (draftId: string, optionId: string) => void;
  readonly onShowMore: (groupKey: string) => void;
}) {
  const { height } = useWindowDimensions();
  const type = useTypeStyle('bodyS');
  return (
    <BottomSheet visible={visible} title="Map of this thread" onClose={onClose} testID="thread-map">
      <View style={styles.body}>
        {large ? (
          <>
            <View style={styles.search}>
              <Icon name="search" size={18} color={content.ink2} />
              <TextInput
                accessibilityLabel="Search branches"
                placeholder="Search branches"
                placeholderTextColor={content.ink2}
                value={query}
                onChangeText={(next) => onQuery(next.slice(0, 80))}
                allowFontScaling={false}
                style={[styles.searchInput, { fontFamily: type.fontFamily, fontSize: type.fontSize }]}
              />
            </View>
            <View style={styles.filters} role="group" aria-label="Which branches">
              {FILTERS.map((entry) => (
                <Button
                  key={entry.filter}
                  label={entry.label}
                  size="sm"
                  variant={filter === entry.filter ? 'ink' : 'ghost'}
                  toggled={filter === entry.filter}
                  onPress={() => onFilter(entry.filter)}
                />
              ))}
            </View>
          </>
        ) : null}
        <Text variant="monoXs" color={content.ink2}>
          ORIGINAL · {view.title.toUpperCase()}
        </Text>
        <ScrollView style={{ maxHeight: height * 0.55 }} contentContainerStyle={styles.list}>
          <View role="tree" accessibilityLabel={`Map of ${view.title}`} style={styles.list}>
            {view.rows.map((row) => (
              <MapLine
                key={row.key}
                row={row}
                onOpenEpisode={onOpenEpisode}
                onOpenBranch={onOpenBranch}
                onOpenOffer={onOpenOffer}
                onShowMore={onShowMore}
              />
            ))}
          </View>
          {view.empty === undefined ? null : (
            <View role="status">
              <Text variant="bodyS" color={content.ink2}>
                {EMPTY[view.empty]}
              </Text>
            </View>
          )}
        </ScrollView>
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  body: { gap: spacing[3] },
  list: { gap: spacing[2] },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    minHeight: 48,
    paddingHorizontal: spacing[4],
    borderRadius: radius.pill,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.paper,
  },
  searchInput: { flex: 1, color: content.ink },
  filters: { flexDirection: 'row', gap: spacing[2], flexWrap: 'wrap' },
});
