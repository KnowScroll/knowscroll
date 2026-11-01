import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import type { AccountScope } from '@knowscroll/client-core';
import { feedChip, launchChip, questionsChip, replayChip, skyLine, watchChip } from '@knowscroll/client-core';
import type {
  RoomFeedStrip,
  RoomLaunchStrip,
  RoomQuestions,
  RoomReplayStrip,
  RoomSky,
  RoomTodayStrip,
  RoomWatchStrip,
} from '@knowscroll/contracts';
import { borderWidth, content, radius, spacing, status } from '@knowscroll/design-tokens';
import { Icon, Text } from '@knowscroll/ui';
import { feedHref, todayHref } from './room-links';
import { SkySheet } from './sky-sheet';

/** One pill of the strip: at least 44 px tall, with words, never colour alone. */
function Chip({
  label,
  detail,
  onPress,
  testID,
  accessibilityLabel,
  star,
  live,
}: {
  readonly label: string;
  readonly detail?: string | undefined;
  readonly onPress: () => void;
  readonly testID: string;
  readonly accessibilityLabel: string;
  readonly star?: boolean;
  /** A Launch is on: a small red mark with the word, never colour alone (R3 E). */
  readonly live?: boolean;
}) {
  return (
    <Pressable
      role="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={styles.chip}
      testID={testID}
    >
      {star === true ? <Icon name="star" size={16} color={content.ink} /> : null}
      {live === true ? <View style={styles.liveDot} aria-hidden /> : null}
      <Text variant="label">{label}</Text>
      {detail === undefined ? null : (
        <Text variant="bodyS" color={content.ink2} numberOfLines={1} style={styles.detail}>
          {detail}
        </Text>
      )}
    </Pressable>
  );
}

/**
 * The Now strip under the room's band (R3 A): the Launch when one can start, is on or just finished, Watch together when a Reel can be
 * started on the stage, a replay of a finished Launch the member did not play, the questions that wait for a person, Today, with its
 * question when an operator approved one, the Feed when a resident has posted a find, and the room's sky. None is a count of people.
 * The Launch opens its start sheet or its podium, Watch together the stage sheet, the replay its sheet, the questions their shelf, Today
 * the daily channel, the Feed the residents' finds, the sky the constellation and its name vote.
 */
export function NowStrip({
  scope,
  roomId,
  today,
  sky,
  launch,
  feed,
  onLaunch,
  watch,
  onWatch,
  replay,
  onReplay,
  questions,
  canAsk,
  onQuestions,
}: {
  readonly scope: AccountScope;
  readonly roomId: string;
  readonly today: RoomTodayStrip | undefined;
  readonly sky: RoomSky;
  readonly launch?: RoomLaunchStrip | undefined;
  /** The newest find a resident posted that this reader may see; absent when there is none or the reader's AI is Off. */
  readonly feed?: RoomFeedStrip | undefined;
  readonly onLaunch?: () => void;
  /** A Reel can be watched together (v3 R-10). The chip is not drawn while one is on: the stage above says so. */
  readonly watch?: RoomWatchStrip | undefined;
  readonly onWatch?: () => void;
  /** A finished Launch this member did not play whose answers are still kept (R-7). */
  readonly replay?: RoomReplayStrip | undefined;
  readonly onReplay?: () => void;
  /** Questions waiting for a person; the chip says how many only when some do, and otherwise offers to leave one. */
  readonly questions?: RoomQuestions | undefined;
  readonly canAsk?: boolean;
  readonly onQuestions?: () => void;
}) {
  const chip = launchChip(launch);
  const watchOf = watchChip(watch);
  const feedPill = feedChip(feed, new Date());
  const replayOf = replayChip(replay);
  const waiting = questionsChip(questions);
  const askChip = waiting ?? (canAsk === true ? { label: 'Ask', detail: 'Leave a question' } : undefined);
  const router = useRouter();
  const [open, setOpen] = useState(false);
  return (
    <View testID="now-strip" role="group" accessibilityLabel="Now in this room">
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
        {chip === undefined ? null : (
          <Chip
            label={chip.label}
            detail={chip.detail}
            live={chip.live}
            accessibilityLabel={`Launch, ${chip.detail}`}
            onPress={() => onLaunch?.()}
            testID="now-launch"
          />
        )}
        {watchOf === undefined ? null : (
          <Chip
            label={watchOf.label}
            detail={watchOf.detail}
            accessibilityLabel={`${watchOf.label}, ${watchOf.detail}`}
            onPress={() => onWatch?.()}
            testID="now-watch"
          />
        )}
        {replayOf === undefined ? null : (
          <Chip
            label={replayOf.label}
            detail={replayOf.detail}
            accessibilityLabel={`Replay, ${replayOf.detail}`}
            onPress={() => onReplay?.()}
            testID="now-replay"
          />
        )}
        {askChip === undefined ? null : (
          <Chip
            label={askChip.label}
            detail={askChip.detail}
            accessibilityLabel={`${askChip.label}, ${askChip.detail}`}
            onPress={() => onQuestions?.()}
            testID="now-questions"
          />
        )}
        {today === undefined ? null : (
          <Chip
            label="Today"
            detail={today.prompt}
            accessibilityLabel={`Today${today.prompt === undefined ? '' : `, ${today.prompt}`}`}
            onPress={() => router.push(todayHref(roomId))}
            testID="now-today"
          />
        )}
        {feedPill === undefined ? null : (
          <Chip
            label={feedPill.label}
            detail={feedPill.detail}
            accessibilityLabel={`Feed, ${feedPill.detail}`}
            onPress={() => router.push(feedHref(roomId))}
            testID="now-feed"
          />
        )}
        <Chip
          star
          label={skyLine(sky)}
          accessibilityLabel={`Room sky, ${skyLine(sky)} stars`}
          onPress={() => setOpen(true)}
          testID="now-sky"
        />
      </ScrollView>
      <SkySheet scope={scope} roomId={roomId} visible={open} onClose={() => setOpen(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { gap: spacing[2], paddingHorizontal: spacing[4], paddingVertical: spacing[2] },
  chip: {
    minHeight: 44,
    maxWidth: 280,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    paddingHorizontal: spacing[3],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.pill,
    backgroundColor: content.paper,
  },
  detail: { flexShrink: 1 },
  liveDot: { width: 10, height: 10, borderRadius: radius.pill, backgroundColor: status.danger.fill },
});
