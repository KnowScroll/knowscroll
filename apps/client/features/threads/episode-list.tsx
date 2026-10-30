import { Pressable, StyleSheet, View } from 'react-native';
import type { ThreadEpisode } from '@knowscroll/contracts';
import { borderWidth, content, radius, spacing, target } from '@knowscroll/design-tokens';
import { Icon, Tag, Text, useFocusRing } from '@knowscroll/ui';
import { episodeKeys, episodeLabel, episodePlace } from './episode-navigator';

function EpisodeRow({
  episode,
  selected,
  series,
  onSelect,
}: {
  readonly episode: ThreadEpisode;
  readonly selected: boolean;
  readonly series: boolean;
  readonly onSelect: () => void;
}) {
  const focus = useFocusRing('onLight');
  return (
    <Pressable
      {...focus.props}
      role="button"
      aria-pressed={selected}
      accessibilityLabel={episodeLabel(episode, selected, series)}
      onPress={onSelect}
      style={[
        styles.row,
        selected ? styles.selected : null,
        episode.state === 'unavailable' ? styles.dashed : null,
        focus.style,
      ]}
      testID={`episode-${episode.assetId}`}
    >
      <View style={styles.tile}>
        <Icon name={episode.kind === 'reel' ? 'reel' : 'scroll'} size={20} color={content.paper} />
      </View>
      <View style={styles.text}>
        <Text variant="monoXs" color={content.ink2}>
          {episodePlace(episode, series)}
        </Text>
        <Text variant="uiS" numberOfLines={2}>
          {episode.title}
        </Text>
      </View>
      <View style={styles.states}>
        {selected ? <Tag variant="part" label="Now" /> : null}
        {episode.state === 'corrected' ? <Tag variant="corrected" label="Updated" /> : null}
        {episode.visited ? <Icon name="check" size={16} color={content.ink} /> : null}
      </View>
    </Pressable>
  );
}

/**
 * The thread's episodes in order, one row each (T3 "Series"): on a phone inside the Series sheet, on a
 * desktop in the thread's panel. Each row shows the caller's own state only: Now (selected on this
 * device), a check for what they opened and played, Updated for a corrected revision, dashed for one
 * that is gone. Another member's place is never drawn: there is none to draw. The arrow keys (up, down,
 * left, right) move the selection between rows while one has focus; only a press chooses a row.
 */
export function EpisodeList({
  episodes,
  selected,
  series,
  onSelect,
  onStep,
}: {
  readonly episodes: readonly ThreadEpisode[];
  readonly selected: string;
  readonly series: boolean;
  /** A press or Enter on a row: choose it (a sheet closes). */
  readonly onSelect: (assetId: string) => void;
  /** An arrow key: move the selection to the neighbour and nothing else (a sheet stays open). */
  readonly onStep: (assetId: string) => void;
}) {
  const current = episodes.findIndex((episode) => episode.assetId === selected);
  const onKeyDown = episodeKeys((by) => {
    const next = episodes[Math.min(Math.max(current + by, 0), episodes.length - 1)];
    if (next !== undefined) onStep(next.assetId);
  }, true);
  return (
    <View
      role="group"
      accessibilityLabel="Episodes in this thread"
      onKeyDown={onKeyDown}
      style={styles.list}
      testID="episode-navigator"
    >
      {episodes.map((episode) => (
        <EpisodeRow
          key={episode.assetId}
          episode={episode}
          selected={episode.assetId === selected}
          series={series}
          onSelect={() => onSelect(episode.assetId)}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: spacing[2] },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    minHeight: target.minimum + spacing[3],
    padding: spacing[2],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.md,
    backgroundColor: content.paper,
  },
  selected: { borderColor: content.accent, borderWidth: 3 },
  dashed: { borderStyle: 'dashed', borderColor: content.muted },
  tile: {
    width: 44,
    height: 44,
    borderRadius: radius.thumb,
    backgroundColor: content.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: { flex: 1, gap: spacing[0.5] },
  states: { flexDirection: 'row', alignItems: 'center', gap: spacing[1.5] },
});
