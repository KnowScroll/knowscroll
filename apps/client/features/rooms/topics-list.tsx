import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import type { AccountScope, RoomController, RoomState } from '@knowscroll/client-core';
import type {
  RoomDiscussionSummary,
  RoomTopicItem,
  RoomTopicSort,
  RoomTopicTag,
  RoomView,
} from '@knowscroll/contracts';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { Button, Icon, Tag, Text } from '@knowscroll/ui';
import { afterPendingBack } from '../../platform/after-pending-back';
import { TAGS, TAG_WORDS } from './ask-words';
import { discussionHref, roomHref } from './room-links';
import { ShareIntoRoomSheet } from './share-into-room-sheet';
import { StartTopicSheet } from './start-topic-sheet';
import { topicFigures } from './topic-card';
import { useRoomTopics } from './use-room';

type Member = Extract<RoomView, { status: 'member' }>;

const SORTS: readonly { readonly sort: RoomTopicSort; readonly label: string }[] = [
  { sort: 'hot', label: 'Hot' },
  { sort: 'new', label: 'New' },
  { sort: 'unanswered', label: 'Unanswered' },
];

/** One choice of a row of choices (a sort or a tag): the chosen one is filled, never shown by colour alone. */
function Chip({
  label,
  selected,
  onPress,
  testID,
}: {
  readonly label: string;
  readonly selected: boolean;
  readonly onPress: () => void;
  readonly testID: string;
}) {
  return (
    <Pressable
      role="radio"
      aria-checked={selected}
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      style={[styles.chip, selected ? styles.chipOn : null]}
      testID={testID}
    >
      <Text variant="metaS" color={selected ? content.onAccent : content.ink}>
        {label}
      </Text>
    </Pressable>
  );
}

function DiscussionRow({
  roomId,
  item,
  selected,
}: {
  readonly roomId: string;
  readonly item: RoomDiscussionSummary & Partial<Pick<RoomTopicItem, 'usefulCount'>>;
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
    topicFigures(item),
    item.usefulCount === undefined || item.usefulCount === 0 ? undefined : `${String(item.usefulCount)} useful`,
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
          {item.tag === undefined ? null : (
            <View style={styles.tagLine}>
              <Tag label={TAG_WORDS[item.tag]} />
            </View>
          )}
          <Text variant="ui" numberOfLines={2}>
            {item.title}
          </Text>
          <Text variant="meta" color={content.ink2} numberOfLines={2}>
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
  const [starting, setStarting] = useState(false);
  const [sort, setSort] = useState<RoomTopicSort>('hot');
  const [tag, setTag] = useState<RoomTopicTag>();
  // The forum list (sorted, filtered, with figures) is read apart from the room; until it arrives the room's own list stands.
  const pinned = pinnedOnly === true;
  const forum = useRoomTopics(scope, view.room.roomId, {
    sort,
    tag,
    refreshKey: view.discussions,
    enabled: !pinned,
  });
  const items: readonly (RoomDiscussionSummary & Partial<Pick<RoomTopicItem, 'usefulCount'>>)[] = pinned
    ? view.discussions.filter((item) => item.pinned)
    : (forum ?? view.discussions.filter((item) => tag === undefined || item.tag === tag));
  return (
    <>
      <View style={styles.listHeader}>
        <Text variant="monoXs" color={content.ink2}>
          {pinned ? 'Pins' : 'Topics'}
        </Text>
        <View style={styles.actions}>
          {view.canPost && !pinned ? (
            <Button
              label="New topic"
              size="sm"
              variant="primary"
              onPress={() => setStarting(true)}
              testID="new-topic"
            />
          ) : null}
          {view.canPost && !pinned && canShare ? (
            <Button label="Share into room" size="sm" onPress={() => setSharing(true)} testID="share-into-room" />
          ) : null}
        </View>
      </View>
      {pinned ? null : (
        <View style={styles.filters}>
          <View role="radiogroup" accessibilityLabel="Order topics by" style={styles.chips}>
            {SORTS.map((entry) => (
              <Chip
                key={entry.sort}
                label={entry.label}
                selected={entry.sort === sort}
                onPress={() => setSort(entry.sort)}
                testID={`sort-${entry.sort}`}
              />
            ))}
          </View>
          <View role="radiogroup" accessibilityLabel="Show topics tagged" style={styles.chips}>
            <Chip label="All" selected={tag === undefined} onPress={() => setTag(undefined)} testID="tag-all" />
            {TAGS.map((entry) => (
              <Chip
                key={entry}
                label={TAG_WORDS[entry]}
                selected={entry === tag}
                onPress={() => setTag(entry)}
                testID={`tag-${entry}`}
              />
            ))}
          </View>
        </View>
      )}
      {general === undefined ? null : <GeneralRow roomId={view.room.roomId} selected={general.selected} />}
      {items.length === 0 ? (
        <View style={styles.quiet}>
          <Text variant="ui">
            {pinned ? 'Nothing pinned' : tag === undefined ? 'Nothing here yet' : 'No topics with this tag'}
          </Text>
          <Text variant="meta" color={content.ink2}>
            {pinned
              ? 'A moderator can pin a discussion to the top of the room.'
              : 'Start a topic from any message, or with New topic. People who join will find it here.'}
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
      <StartTopicSheet
        visible={starting}
        suggestedTitle=""
        working={state.working}
        onClose={() => setStarting(false)}
        onStart={(title, chosen) =>
          void controller
            .startDiscussion({ kind: 'topic', title, ...(chosen === undefined ? {} : { tag: chosen }) })
            .then((discussionId) => {
              if (discussionId === undefined) return;
              setStarting(false);
              afterPendingBack(() => router.push(discussionHref(view.room.roomId, discussionId)));
            })
        }
      />
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
  listHeader: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing[2],
  },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing[2] },
  filters: { gap: spacing[2] },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  chip: {
    minHeight: 36,
    justifyContent: 'center',
    paddingHorizontal: spacing[3],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.pill,
    backgroundColor: content.paper,
  },
  chipOn: { backgroundColor: content.accent },
  tagLine: { flexDirection: 'row' },
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
