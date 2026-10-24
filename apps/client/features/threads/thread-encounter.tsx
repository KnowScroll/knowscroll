import { useRouter } from 'expo-router';
import { useCallback, useState, type RefObject } from 'react';
import { StyleSheet, View } from 'react-native';
import type { AccountScope } from '@knowscroll/client-core';
import type { ContentThreadRef, ReelDocument, ThreadEpisode } from '@knowscroll/contracts';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { Banner, Button, IconButton, StateBlock, Tag, Text, type ReelPositionHandle } from '@knowscroll/ui';
import { ReelEncounter } from './reel-encounter';
import { readInThreadHref } from './thread-links';

/** The picture of the inline player takes at most this much, so the conversation stays in view. */
const PLAYER_STAGE_HEIGHT = 200;

export interface ThreadEncounterProps {
  readonly scope: AccountScope;
  readonly thread: ContentThreadRef;
  readonly episode: ThreadEpisode;
  readonly series: boolean;
  readonly total: number;
  /** Folded: the player is paused and only a bar shows (C04 "Collapsed"). */
  readonly folded: boolean;
  readonly onToggleFold: () => void;
  /** Opens H03's "Share a moment" for the Reel that is playing. */
  readonly onShareMoment: (opened: { document: ReelDocument; positionMs: number }) => void;
  /** Another thing is on top (a sheet): the player pauses. */
  readonly paused: boolean;
  /** The screen's handle on the playing Reel, to read where it is when a moment is shared. */
  readonly positionRef: RefObject<ReelPositionHandle | null>;
  /** Called with the Reel's document once it is playing, so the screen knows what a moment can be. */
  readonly onOpened?: (document: ReelDocument | undefined) => void;
  /** The episode's summary line from the thread's root, when this is the root. */
  readonly summary?: string | undefined;
}

/**
 * C04's encounter area: the selected episode. A Reel plays inline (after Play: showing it is not
 * watching it); a Scroll is read on its own screen, where a passage or block can be shared back.
 * Folding the player pauses it and the episode keeps its place. Like and Save stay on the full
 * screen encounter, which is one tap away.
 */
export function ThreadEncounter({
  scope,
  thread,
  episode,
  series,
  total,
  folded,
  onToggleFold,
  onShareMoment,
  paused,
  positionRef,
  onOpened,
  summary,
}: ThreadEncounterProps) {
  const router = useRouter();
  const [opened, setOpened] = useState<ReelDocument>();
  const handleOpened = useCallback(
    (document: ReelDocument) => {
      setOpened(document);
      onOpened?.(document);
    },
    [onOpened],
  );
  const place =
    series && episode.part !== undefined
      ? `Part ${String(episode.part)} of ${String(total)}`
      : episode.kind === 'reel'
        ? 'Reel'
        : 'Scroll';
  const fullHref = `/${episode.kind}/${episode.assetId}`;

  if (episode.state === 'unavailable')
    return (
      <View style={styles.area}>
        <StateBlock title="This isn’t available any more" body="It was withdrawn. The conversation stays." />
      </View>
    );

  const header = (
    <View style={styles.header}>
      <Tag variant="part" label={place} />
      {episode.state === 'corrected' ? <Tag variant="corrected" label="Updated" /> : null}
      <View style={styles.grow} />
      {episode.kind === 'reel' ? (
        <IconButton
          icon={folded ? 'plus' : 'minus'}
          label={folded ? 'Unfold the player' : 'Fold the player'}
          onPress={onToggleFold}
        />
      ) : null}
    </View>
  );

  if (episode.kind === 'scroll')
    return (
      <View style={styles.area}>
        {header}
        <View style={styles.scrollCard}>
          <Text variant="title" numberOfLines={3}>
            {episode.title}
          </Text>
          {summary === undefined || summary === '' ? null : (
            <Text variant="bodyS" color={content.ink2} numberOfLines={3}>
              {summary}
            </Text>
          )}
          {episode.state === 'corrected' ? (
            <Banner kind="corrected" lead="Updated." message="You will read the current version." />
          ) : null}
          <View style={styles.actions}>
            <Button
              label="Read this Scroll"
              variant="primary"
              onPress={() => router.push(readInThreadHref(thread, episode.assetId))}
            />
            <Button label="Full screen" variant="ghost" onPress={() => router.push(fullHref)} />
          </View>
        </View>
      </View>
    );

  // Folded, the player stays mounted but hidden and paused: it keeps its place, and no second player starts.
  return (
    <View style={styles.area}>
      {header}
      {folded ? (
        <View style={styles.mini}>
          <Text variant="uiS" color={content.paper} numberOfLines={1} style={styles.grow}>
            {place} · {episode.title}
          </Text>
          <Text variant="monoXs" color={content.paper}>
            Paused
          </Text>
        </View>
      ) : null}
      <View style={folded ? styles.hidden : styles.player}>
        {episode.state === 'corrected' ? (
          <Banner kind="corrected" lead="Updated." message="You will see the current version." />
        ) : null}
        <ReelEncounter
          key={episode.assetId}
          scope={scope}
          assetId={episode.assetId}
          title={episode.title}
          summary={summary}
          active={!folded && !paused}
          positionRef={positionRef}
          onOpened={handleOpened}
          stageMaxHeight={PLAYER_STAGE_HEIGHT}
        />
        <View style={styles.actions}>
          <Button
            label="Share a moment"
            icon="share"
            disabled={opened === undefined}
            accessibilityHint={
              opened === undefined ? 'Play the Reel first, then share the moment you are at' : undefined
            }
            onPress={() => {
              if (opened !== undefined)
                onShareMoment({ document: opened, positionMs: positionRef.current?.capture()?.positionMs ?? 0 });
            }}
            testID="share-a-moment"
          />
          <Button label="Full screen" variant="ghost" onPress={() => router.push(fullHref)} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  area: {
    gap: spacing[3],
    paddingHorizontal: spacing[5],
    paddingBottom: spacing[3],
    borderBottomWidth: borderWidth.regular,
    borderBottomColor: content.ink,
    backgroundColor: content.paper,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
  grow: { flex: 1 },
  player: { gap: spacing[3] },
  hidden: { display: 'none' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  scrollCard: {
    gap: spacing[3],
    padding: spacing[4],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.card,
  },
  mini: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    padding: spacing[3],
    borderRadius: radius.panel,
    backgroundColor: content.ink,
  },
});
