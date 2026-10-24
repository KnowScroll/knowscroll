import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import type { ThreadEpisode } from '@knowscroll/contracts';
import { borderWidth, content, radius, spacing, target } from '@knowscroll/design-tokens';
import { Icon, Tag, Text, useFocusRing } from '@knowscroll/ui';

/** The words a screen reader gets for one episode: its place, its title and each state as a word, never colour alone. */
export function episodeLabel(episode: ThreadEpisode, selected: boolean, series: boolean): string {
  const place =
    series && episode.part !== undefined ? `Part ${String(episode.part)}` : episode.kind === 'reel' ? 'Reel' : 'Scroll';
  const states = [
    selected ? 'selected' : undefined,
    episode.visited ? 'visited by you' : undefined,
    episode.state === 'corrected' ? 'updated' : undefined,
    episode.state === 'unavailable' ? 'no longer available' : undefined,
  ].filter((word): word is string => word !== undefined);
  return `${place}, ${episode.title}${states.length === 0 ? '' : `, ${states.join(', ')}`}`;
}

function placeOf(episode: ThreadEpisode, series: boolean): string {
  if (series && episode.part !== undefined) return `Part ${String(episode.part)}`;
  return episode.kind === 'reel' ? 'Reel' : 'Scroll';
}

function EpisodeCard({
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
  const unavailable = episode.state === 'unavailable';
  return (
    <Pressable
      {...focus.props}
      role="button"
      aria-pressed={selected}
      accessibilityLabel={episodeLabel(episode, selected, series)}
      onPress={onSelect}
      style={[styles.card, selected ? styles.selected : null, unavailable ? styles.dashed : null, focus.style]}
      testID={`episode-${episode.assetId}`}
    >
      <View style={styles.tile}>
        <Icon name={episode.kind === 'reel' ? 'reel' : 'scroll'} size={22} color={content.paper} />
        {selected ? (
          <View style={styles.now}>
            <Text variant="monoXs" color={content.onContinue}>
              Now
            </Text>
          </View>
        ) : null}
        {episode.visited ? (
          <View style={styles.visited}>
            <Icon name="check" size={12} color={content.ink} />
          </View>
        ) : null}
      </View>
      <View style={styles.cardText}>
        <Text variant="monoXs" color={content.ink2}>
          {placeOf(episode, series)}
        </Text>
        <Text variant="uiS" numberOfLines={2}>
          {episode.title}
        </Text>
        {episode.state === 'corrected' ? <Tag variant="corrected" label="Updated" /> : null}
      </View>
    </Pressable>
  );
}

function Chip({
  index,
  episode,
  selected,
  series,
  onSelect,
}: {
  readonly index: number;
  readonly episode: ThreadEpisode;
  readonly selected: boolean;
  readonly series: boolean;
  readonly onSelect: () => void;
}) {
  const focus = useFocusRing(selected ? 'onDark' : 'onLight');
  return (
    <Pressable
      {...focus.props}
      role="button"
      aria-pressed={selected}
      accessibilityLabel={episodeLabel(episode, selected, series)}
      onPress={onSelect}
      style={[styles.chip, selected ? styles.chipSelected : null, focus.style]}
    >
      <Text variant="uiS" color={selected ? content.paper : content.ink}>
        {episode.part ?? index + 1}
        {selected ? ' · now' : ''}
        {episode.visited && !selected ? ' ✓' : ''}
      </Text>
    </Pressable>
  );
}

/**
 * The thread's episodes in order (C04). Scrolling it owns its horizontal gesture. Each card shows the
 * caller's own state only: Now (selected on this device), a check for what they opened and played,
 * Updated for a corrected revision, dashed for one that is gone. Another member's place is never
 * drawn: there is none to draw. Folded, it is numbered chips.
 */
export function EpisodeNavigator({
  episodes,
  selected,
  series,
  folded,
  onSelect,
}: {
  readonly episodes: readonly ThreadEpisode[];
  readonly selected: string;
  readonly series: boolean;
  readonly folded: boolean;
  readonly onSelect: (assetId: string) => void;
}) {
  const step = (from: number, by: number) => {
    const next = episodes[Math.min(Math.max(from + by, 0), episodes.length - 1)];
    if (next !== undefined) onSelect(next.assetId);
  };
  const current = episodes.findIndex((episode) => episode.assetId === selected);
  // Arrow keys move between episodes on the web; a swipe scrolls on a phone.
  const onKeyDown = (event: unknown) => {
    const { key, preventDefault } = event as { key?: string; preventDefault?: () => void };
    if (key === 'ArrowRight' || key === 'ArrowLeft') {
      preventDefault?.();
      step(current, key === 'ArrowRight' ? 1 : -1);
    }
  };
  return (
    <View role="group" accessibilityLabel="Episodes in this thread" onKeyDown={onKeyDown}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.strip}
        testID="episode-navigator"
      >
        {episodes.map((episode, index) =>
          folded ? (
            <Chip
              key={episode.assetId}
              index={index}
              episode={episode}
              selected={episode.assetId === selected}
              series={series}
              onSelect={() => onSelect(episode.assetId)}
            />
          ) : (
            <EpisodeCard
              key={episode.assetId}
              episode={episode}
              selected={episode.assetId === selected}
              series={series}
              onSelect={() => onSelect(episode.assetId)}
            />
          ),
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  strip: { gap: spacing[2], paddingHorizontal: spacing[5], paddingVertical: spacing[3] },
  card: {
    width: 116,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.md,
    backgroundColor: content.paper,
    overflow: 'hidden',
  },
  selected: { borderColor: content.accent, borderWidth: 3 },
  dashed: { borderStyle: 'dashed', borderColor: content.muted },
  tile: {
    height: 56,
    backgroundColor: content.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  now: {
    position: 'absolute',
    top: spacing[1],
    right: spacing[1],
    paddingHorizontal: spacing[1.5],
    borderRadius: radius.tag,
    backgroundColor: content.continue,
  },
  visited: {
    position: 'absolute',
    top: spacing[1],
    left: spacing[1],
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: content.paper,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardText: { padding: spacing[2], gap: spacing[0.5] },
  chip: {
    minWidth: target.minimum,
    minHeight: target.minimum,
    paddingHorizontal: spacing[3],
    borderRadius: radius.md,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.paper,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipSelected: { backgroundColor: content.ink },
});
