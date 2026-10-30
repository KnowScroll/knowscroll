import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import type { AccountScope, RoomController, RoomState } from '@knowscroll/client-core';
import type { RoomDiscussionSummary, RoomView } from '@knowscroll/contracts';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { Button, Icon, Text } from '@knowscroll/ui';
import { afterPendingBack } from '../../platform/after-pending-back';
import { discussionHref, roomHref } from './room-links';
import { ShareIntoRoomSheet } from './share-into-room-sheet';

type Member = Extract<RoomView, { status: 'member' }>;

function DiscussionRow({
  roomId,
  item,
  selected,
}: {
  readonly roomId: string;
  readonly item: RoomDiscussionSummary;
  /** The discussion open beside the list (D04). */
  readonly selected?: boolean;
}) {
  const router = useRouter();
  const metadata =
    item.root?.status === 'available'
      ? item.root.metadata
      : item.root?.status === 'corrected'
        ? item.root.current.metadata
        : undefined;
  const kind =
    metadata === undefined
      ? item.root === undefined
        ? undefined
        : 'content'
      : metadata.kind === 'reel'
        ? 'Reel'
        : 'Scroll';
  const subtitle = [
    kind ?? 'Discussion',
    item.startedBy === undefined ? undefined : `started by ${item.startedBy.displayName}`,
  ]
    .filter((part): part is string => part !== undefined)
    .join(' · ');
  const href = discussionHref(roomId, item.discussionId);
  return (
    <Pressable
      role="link"
      accessibilityLabel={`${item.pinned ? 'Pinned by the moderator. ' : ''}${item.title}, ${subtitle}`}
      onPress={() => router.push(href)}
      aria-current={selected === true ? 'true' : undefined}
      style={[styles.row, item.pinned ? styles.rowPinned : null, selected === true ? styles.rowSelected : null]}
      testID={`discussion-${item.discussionId}`}
    >
      {item.pinned ? (
        <View style={styles.pinnedLabel}>
          <Icon name="shield" size={12} color={content.freshInk} />
          <Text variant="metaS" color={content.freshInk}>
            Pinned by the moderator
          </Text>
        </View>
      ) : null}
      <View style={styles.rowMain}>
        <View style={styles.tile} aria-hidden>
          <Icon
            name={metadata?.kind === 'scroll' ? 'scroll' : metadata?.kind === 'reel' ? 'reel' : 'ask'}
            size={20}
            color={content.paper}
          />
        </View>
        <View style={styles.rowText}>
          <Text variant="ui" numberOfLines={2}>
            {item.title}
          </Text>
          <Text variant="meta" color={content.ink2} numberOfLines={1}>
            {subtitle}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

/** General's own row: it is where a member lands, so it leads the list and is never pinned or counted as a topic. */
function GeneralRow({ roomId, selected }: { readonly roomId: string; readonly selected: boolean }) {
  const router = useRouter();
  return (
    <Pressable
      role="link"
      accessibilityLabel="General"
      onPress={() => router.replace(roomHref(roomId))}
      aria-current={selected ? 'true' : undefined}
      style={[styles.row, selected ? styles.rowSelected : null]}
      testID="general-row"
    >
      <View style={styles.rowMain}>
        <View style={styles.tile} aria-hidden>
          <Icon name="talk" size={20} color={content.paper} />
        </View>
        <View style={styles.rowText}>
          <Text variant="ui">General</Text>
          <Text variant="meta" color={content.ink2}>
            Where the room talks
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

/**
 * The room's discussions other than General, pinned first, and the ways to start one: share a Reel or Scroll into
 * the room, which starts a content thread. With `general` the list opens with General's own row, marked when it is
 * the discussion open beside the list. Honestly empty when nothing has been started, and never filled.
 */
export function TopicsList({
  scope,
  view,
  controller,
  state,
  selectedDiscussionId,
  general,
  pinnedOnly,
  canShare = true,
}: {
  readonly scope: AccountScope;
  readonly view: Member;
  readonly controller: RoomController;
  readonly state: RoomState;
  readonly selectedDiscussionId?: string;
  readonly general?: { readonly selected: boolean };
  /** Only the pinned discussions: the room menu's Pins. */
  readonly pinnedOnly?: boolean;
  /** Whether this list offers sharing into the room (the room menu opens that sheet itself, never inside its own). */
  readonly canShare?: boolean;
}) {
  const router = useRouter();
  const [sharing, setSharing] = useState(false);
  const items = pinnedOnly === true ? view.discussions.filter((item) => item.pinned) : view.discussions;
  return (
    <>
      <View style={styles.listHeader}>
        <Text variant="monoXs" color={content.ink2}>
          {pinnedOnly === true ? 'Pins' : 'Threads'}
        </Text>
        {view.canPost && pinnedOnly !== true && canShare ? (
          <Button
            label="Share into room"
            size="sm"
            variant="primary"
            onPress={() => setSharing(true)}
            testID="share-into-room"
          />
        ) : null}
      </View>
      {general === undefined ? null : <GeneralRow roomId={view.room.roomId} selected={general.selected} />}
      {items.length === 0 ? (
        <View style={styles.quiet}>
          <Text variant="ui">{pinnedOnly === true ? 'Nothing pinned' : 'Nothing here yet'}</Text>
          <Text variant="meta" color={content.ink2}>
            {pinnedOnly === true
              ? 'A moderator can pin a discussion to the top of the room.'
              : 'Be the first to start a discussion. People who join will find it here.'}
          </Text>
        </View>
      ) : (
        <View role="list" accessibilityLabel="Discussions in this room" style={styles.rows}>
          {items.map((item) => (
            <View key={item.discussionId} role="listitem">
              <DiscussionRow
                roomId={view.room.roomId}
                item={item}
                selected={item.discussionId === selectedDiscussionId}
              />
            </View>
          ))}
        </View>
      )}
      {canShare ? (
        <ShareIntoRoomSheet
          scope={scope}
          visible={sharing}
          working={state.working}
          onClose={() => setSharing(false)}
          onStart={(start) =>
            void controller.startDiscussion(start).then((discussionId) => {
              if (discussionId === undefined) return;
              // The sheet's close is a Back on the web; navigate once it has landed, or it would undo the push.
              setSharing(false);
              afterPendingBack(() => router.push(discussionHref(view.room.roomId, discussionId)));
            })
          }
        />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  listHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rows: { gap: spacing[2] },
  row: {
    gap: spacing[2],
    padding: spacing[3],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.card,
    backgroundColor: content.paper,
  },
  rowPinned: { backgroundColor: content.paper2 },
  rowSelected: { backgroundColor: content.continue },
  pinnedLabel: { flexDirection: 'row', alignItems: 'center', gap: spacing[1] },
  rowMain: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
  tile: {
    width: 44,
    height: 44,
    borderRadius: radius.thumb,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: content.accent,
  },
  rowText: { flex: 1, gap: spacing['0.5'] },
  quiet: {
    gap: spacing[1],
    padding: spacing[4],
    borderRadius: radius.lg,
    borderWidth: borderWidth.light,
    borderColor: content.rule,
    backgroundColor: content.paper,
  },
});
