import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import type { RoomActivitiesController, RoomActivitiesState } from '@knowscroll/client-core';
import type { RoomActivitySummary } from '@knowscroll/contracts';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { Button, Icon, Tag, Text } from '@knowscroll/ui';
import { afterPendingBack } from '../../platform/after-pending-back';
import { activitiesHref, activityHref } from './room-links';
import { StartActivitySheet } from './start-activity-sheet';

/** How many rows the room's own page shows before "All room activity". */
const SHOWN = 3;

function ActivityRow({ roomId, item }: { readonly roomId: string; readonly item: RoomActivitySummary }) {
  const router = useRouter();
  const href = activityHref(roomId, item.activityId);
  const kind = item.kind === 'poll' ? 'Poll' : 'Quiz';
  const detail = [kind, item.state === 'closed' ? 'Closed' : 'Optional', item.voted === true ? 'You voted' : undefined]
    .filter((part): part is string => part !== undefined)
    .join(' · ');
  return (
    <Pressable
      role="link"
      accessibilityLabel={`${item.title}, ${detail}`}
      onPress={() => router.push(href)}
      style={styles.row}
      testID={`activity-${item.activityId}`}
    >
      <View style={styles.tile} aria-hidden>
        <Icon name={item.kind === 'poll' ? 'list' : 'ask'} size={18} color={content.paper} />
      </View>
      <View style={styles.rowText}>
        <Text variant="ui" numberOfLines={2}>
          {item.title}
        </Text>
        <Text variant="meta" color={content.ink2}>
          {detail}
        </Text>
      </View>
    </Pressable>
  );
}

/**
 * R03's way in, from inside a room only: the room's polls and quizzes, and for a moderator the two
 * ways to start one. It says "Optional" and shows nothing when there is nothing to show: no badge, no
 * count, no nudge. Never linked from Explore, notifications or the universe.
 */
export function ActivitiesSection({
  roomId,
  state,
  controller,
  all,
}: {
  readonly roomId: string;
  readonly state: RoomActivitiesState;
  readonly controller: RoomActivitiesController;
  /** Show every row (the list screen) instead of the first few and a link. */
  readonly all?: boolean;
}) {
  const router = useRouter();
  const [starting, setStarting] = useState<'poll' | 'quiz'>();
  if (state.phase !== 'ready') return null;
  if (state.activities.length === 0 && !state.canCreate) return null;
  const shown = all === true ? state.activities : state.activities.slice(0, SHOWN);
  return (
    <View style={styles.section} testID="room-activities">
      <View style={styles.head}>
        <Text variant="monoXs" color={content.ink2}>
          Room activity
        </Text>
        <Tag label="Optional" />
      </View>
      {shown.length === 0 ? (
        <Text variant="meta" color={content.ink2}>
          Nothing open. Nobody has to join in.
        </Text>
      ) : (
        <View role="list" accessibilityLabel="Polls and quizzes in this room" style={styles.rows}>
          {shown.map((item) => (
            <View key={item.activityId} role="listitem">
              <ActivityRow roomId={roomId} item={item} />
            </View>
          ))}
        </View>
      )}
      {all === true || state.activities.length <= SHOWN ? null : (
        <Button
          label="All room activity"
          size="sm"
          variant="ghost"
          role="link"
          href={activitiesHref(roomId)}
          onPress={() => router.push(activitiesHref(roomId))}
        />
      )}
      {state.canCreate ? (
        <View style={styles.moderator}>
          <Text variant="metaS" color={content.freshInk}>
            Moderator: start something optional
          </Text>
          <View style={styles.buttons}>
            <Button label="Start a poll" size="sm" onPress={() => setStarting('poll')} testID="start-poll" />
            <Button label="Start a quiz" size="sm" onPress={() => setStarting('quiz')} testID="start-quiz" />
          </View>
        </View>
      ) : null}
      <StartActivitySheet
        kind={starting}
        controller={controller}
        state={state}
        onClose={() => setStarting(undefined)}
        onStarted={(activityId) => {
          // The sheet's close is a Back on the web; navigate once it has landed, or it would undo the push.
          setStarting(undefined);
          afterPendingBack(() => router.push(activityHref(roomId, activityId)));
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: spacing[3] },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rows: { gap: spacing[2] },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    padding: spacing[3],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.card,
    backgroundColor: content.paper,
    cursor: 'pointer' as const,
  },
  tile: {
    width: 40,
    height: 40,
    borderRadius: radius.thumb,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: content.ink,
  },
  rowText: { flex: 1, gap: spacing['0.5'] },
  moderator: { gap: spacing[2], padding: spacing[3], borderRadius: radius.card, backgroundColor: content.freshTint },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
});
