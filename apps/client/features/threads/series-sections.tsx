import { StyleSheet, View } from 'react-native';
import type { ThreadCall, ThreadEpisode, ThreadPlace } from '@knowscroll/contracts';
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
  places,
  calls,
  onSelect,
  onStep,
  onCall,
  onMap,
}: {
  readonly episodes: readonly ThreadEpisode[];
  readonly selected: string;
  readonly series: boolean;
  /** The panel names the section; the sheet already carries the name as its title. */
  readonly heading: string | undefined;
  /** The members who share where they are, for the faces on their parts. */
  readonly places?: readonly ThreadPlace[] | undefined;
  /** The calls of the parts that have one, with a chip under each part's row (D-155). */
  readonly calls?: readonly ThreadCall[] | undefined;
  readonly onSelect: (assetId: string) => void;
  readonly onStep: (assetId: string) => void;
  /** Opens the call before a part. */
  readonly onCall?: ((part: number) => void) | undefined;
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
      <EpisodeList
        episodes={episodes}
        selected={selected}
        series={series}
        places={places}
        calls={calls}
        onSelect={onSelect}
        onStep={onStep}
        onCall={onCall}
      />
      {onMap === undefined ? null : (
        <Button label="Map" size="sm" variant="ghost" onPress={onMap} testID="thread-map-button" />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: spacing[3], alignItems: 'stretch' },
});
