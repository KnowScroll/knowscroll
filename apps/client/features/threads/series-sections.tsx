import { StyleSheet, View } from 'react-native';
import type { ThreadEpisode } from '@knowscroll/contracts';
import { content, spacing } from '@knowscroll/design-tokens';
import { Button, Text } from '@knowscroll/ui';
import { EpisodeList } from './episode-list';

/** The line above the parts: what the thread walks through and how long it is, e.g. "A SERIES · 3 PARTS". */
export function seriesHeading(series: boolean, count: number): string {
  const noun = series ? 'PART' : 'ITEM';
  return `${series ? 'A SERIES' : 'IN THIS THREAD'} · ${String(count)} ${noun}${count === 1 ? '' : 'S'}`;
}

/**
 * The parts of the thread and the way into the branch map (T3 "Series"). A phone shows it pulled down
 * from the header; a desktop keeps it in the panel beside the conversation. Choosing a part only moves
 * this person's own place on this device.
 */
export function PartsSection({
  episodes,
  selected,
  series,
  heading,
  onSelect,
  onStep,
  onMap,
}: {
  readonly episodes: readonly ThreadEpisode[];
  readonly selected: string;
  readonly series: boolean;
  /** The panel names the section; the sheet already carries the name as its title. */
  readonly heading: string | undefined;
  readonly onSelect: (assetId: string) => void;
  readonly onStep: (assetId: string) => void;
  /** Offered only once the thread has several branches (X04); never for a first exploration. */
  readonly onMap: (() => void) | undefined;
}) {
  return (
    <View style={styles.section}>
      {heading === undefined ? null : (
        <Text variant="monoXs" heading={2} color={content.ink2}>
          {heading}
        </Text>
      )}
      <EpisodeList episodes={episodes} selected={selected} series={series} onSelect={onSelect} onStep={onStep} />
      {onMap === undefined ? null : (
        <Button label="Map" size="sm" variant="ghost" onPress={onMap} testID="thread-map-button" />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: spacing[3], alignItems: 'stretch' },
});
