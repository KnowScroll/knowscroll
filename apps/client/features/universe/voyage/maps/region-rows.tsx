import { Pressable, StyleSheet, View } from 'react-native';
import { borderWidth, content, radius, spacing, target, universe } from '@knowscroll/design-tokens';
import { Icon, Text, useFocusRing } from '@knowscroll/ui';
import type { PlanetPalette } from '../../planet/planet-palette';
import type { PlannedRegion } from '../../planet/planet-plan';
import { KIND_PHRASE } from '../../scene-parts';

/** "4 regions": formed regions only, never "of" a total (D-109). */
export const countWords = (count: number): string => `${count} ${count === 1 ? 'region' : 'regions'}`;

/** The words a screen reader hears for a row, the same as a region's button on the map: "Deployment, a region". */
export function rowName(region: PlannedRegion['descriptor'], here: boolean): string {
  return [
    `${region.label}, ${KIND_PHRASE.region}`,
    ...(region.truthStatus === 'hypothetical' ? ['hypothetical'] : []),
    ...(here ? ['you were here'] : []),
  ].join(', ');
}

/**
 * The regions that have formed, as 48 px rows in map order (the order the Simple drawing lists them in): the way to
 * every region for a keyboard or a screen reader, and the legend of the drawing above it, so its swatches are the
 * colours on the map. It is the only place land is counted, and it counts formed regions alone: land that is not
 * reached yet has no row, no number and no word (D-109).
 */
export function RegionRows({
  regions,
  palette,
  hereId,
  onChoose,
}: {
  readonly regions: readonly PlannedRegion[];
  readonly palette: PlanetPalette;
  /** The region left through Open. */
  readonly hereId: string | null | undefined;
  readonly onChoose: (regionId: string) => void;
}) {
  return (
    <View style={styles.card} testID="map-regions">
      <View style={styles.head}>
        <Text variant="title" heading={2}>
          Regions
        </Text>
        <Text variant="label" color={content.ink2} testID="map-region-count">
          {countWords(regions.length)}
        </Text>
      </View>
      <View style={styles.rows} role="list">
        {regions.map(({ descriptor, site }) => (
          <Row
            key={descriptor.objectId}
            descriptor={descriptor}
            swatch={palette.land[(site ?? 0) % 4]!}
            ink={palette.ink}
            here={descriptor.objectId === hereId}
            onPress={() => onChoose(descriptor.objectId)}
          />
        ))}
      </View>
    </View>
  );
}

function Row({
  descriptor,
  swatch,
  ink,
  here,
  onPress,
}: {
  readonly descriptor: PlannedRegion['descriptor'];
  readonly swatch: string;
  readonly ink: string;
  readonly here: boolean;
  readonly onPress: () => void;
}) {
  const focus = useFocusRing('onLight');
  return (
    <View role="listitem">
      <Pressable
        testID={`map-region-${descriptor.objectId}`}
        accessibilityRole="button"
        accessibilityLabel={rowName(descriptor, here)}
        onPress={onPress}
        {...focus.props}
        style={[styles.row, focus.style]}
      >
        <View aria-hidden style={[styles.swatch, { backgroundColor: swatch, borderColor: ink }]} />
        <View style={styles.words}>
          <Text variant="ui" numberOfLines={2}>
            {descriptor.label}
          </Text>
          {descriptor.truthStatus === 'hypothetical' || here ? (
            <View style={styles.notes}>
              {descriptor.truthStatus === 'hypothetical' ? (
                <Text variant="label" color={content.ink2}>
                  Hypothetical
                </Text>
              ) : null}
              {here ? (
                <View style={styles.here}>
                  <View style={styles.hereDot} />
                  <Text variant="label" color={content.ink2}>
                    You were here
                  </Text>
                </View>
              ) : null}
            </View>
          ) : null}
        </View>
        <Icon name="arrowRight" size={18} color={content.ink} strokeWidth={2.4} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: content.paper,
    borderRadius: radius.card,
    paddingHorizontal: spacing[4],
    paddingTop: spacing[4],
    paddingBottom: spacing[2],
    gap: spacing[2],
    // The paper's own two-pixel ink, as the cards over the Universe wear it.
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
  },
  head: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: spacing[3] },
  rows: { gap: 0 },
  row: {
    minHeight: target.comfortable + 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    paddingVertical: spacing[2],
    borderTopWidth: borderWidth.hairline,
    borderTopColor: content.rule,
    cursor: 'pointer' as const,
  },
  swatch: { width: 20, height: 20, borderRadius: 10, borderWidth: 2 },
  words: { flex: 1, minWidth: 0, gap: 2 },
  notes: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: spacing[3] },
  here: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  hereDot: { width: 9, height: 9, borderRadius: 4.5, backgroundColor: universe.orange },
});
