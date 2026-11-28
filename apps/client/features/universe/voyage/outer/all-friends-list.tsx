import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { borderWidth, content, spacing, target, universe as palette } from '@knowscroll/design-tokens';
import { Banner, BottomSheet, Button, Skeleton, Text, useFocusRing } from '@knowscroll/ui';
import { closeThen } from '../../../../platform/close-then';
import { SpaceChip } from '../../space-chip';
import { allFriendsLabel, friendButtonName, initialOf, type OuterStatus } from './outer-copy';
import type { OuterFriend } from './friend-order';

/**
 * Every friend as a plain list: the way to all of them for the keyboard and a screen reader, and for anyone with more
 * friends than the field shows at a time. It is a real list (a visible focus, rows of at least 48 px), not a mirror of
 * the field, and it holds friends only: the prototype's unnamed universes are never in it.
 */

/** The chip at the stop that opens the list: "All friends (14)". */
export function AllFriendsChip({
  count,
  status = 'ready',
  complete = true,
  onPress,
  testID = 'outer-all-friends',
}: {
  readonly count: number;
  /** Where the read has got to; with `complete`, it decides whether the chip may say a count (`allFriendsLabel`). */
  readonly status?: OuterStatus;
  readonly complete?: boolean;
  readonly onPress: () => void;
  readonly testID?: string;
}) {
  return (
    <SpaceChip
      testID={testID}
      variant="ghost"
      icon="person"
      label={allFriendsLabel(count, status, complete)}
      onPress={onPress}
    />
  );
}

function Row({ friend, onChoose }: { readonly friend: OuterFriend; readonly onChoose: (handle: string) => void }) {
  const focus = useFocusRing('onLight');
  return (
    <Pressable
      testID={`outer-row-${friend.handle}`}
      accessibilityRole="button"
      accessibilityLabel={`${friendButtonName(friend.name)}, @${friend.handle}`}
      onPress={() => onChoose(friend.handle)}
      {...focus.props}
      style={[styles.row, focus.style]}
    >
      <View style={styles.disc} aria-hidden importantForAccessibility="no-hide-descendants">
        <Text variant="uiS" color={palette.ink} align="center">
          {initialOf(friend.name)}
        </Text>
      </View>
      <View style={styles.text}>
        <Text variant="ui" numberOfLines={1}>
          {friend.name}
        </Text>
        <Text variant="meta" color={content.ink2} numberOfLines={1}>
          {`@${friend.handle}`}
        </Text>
      </View>
    </Pressable>
  );
}

/** The rows, with what the read says above them. A press calls `onChoose(handle)`. */
export function AllFriendsList({
  friends,
  status = 'ready',
  complete = true,
  onChoose,
  onRetry,
}: {
  readonly friends: readonly OuterFriend[];
  readonly status?: OuterStatus;
  /** False for a roster the read did not finish: the list says so rather than passing itself off as all of them. */
  readonly complete?: boolean;
  readonly onChoose: (handle: string) => void;
  readonly onRetry?: () => void;
}) {
  const failed = status === 'offline' || status === 'failed';
  return (
    <View testID="outer-friends-list" style={styles.list}>
      {status === 'loading' && friends.length === 0 ? <Skeleton rows={2} label="Looking for your friends" /> : null}
      {failed ? (
        <View style={styles.notice}>
          <Banner
            kind="error"
            lead="Couldn’t load all of your friends."
            message={status === 'offline' ? 'You are offline.' : 'Try again in a moment.'}
          />
          {onRetry === undefined ? null : (
            <Button label="Try again" variant="ghost" onPress={onRetry} testID="outer-list-retry" />
          )}
        </View>
      ) : null}
      {status === 'ready' && !complete ? (
        <Text variant="bodyS" color={content.ink2}>{`Showing the first ${friends.length} friends.`}</Text>
      ) : null}
      {status === 'ready' && friends.length === 0 ? (
        <Text variant="bodyS">You haven’t got any friends here yet. Invite a friend from Talk.</Text>
      ) : null}
      <ScrollView style={styles.scroll} accessibilityLabel={allFriendsLabel(friends.length, status, complete)}>
        {friends.map((friend) => (
          <Row key={friend.personId} friend={friend} onChoose={onChoose} />
        ))}
      </ScrollView>
    </View>
  );
}

/**
 * The list in a bottom sheet. A row closes the sheet and then crosses (`closeThen`, so the visit screen is not popped
 * by the sheet's own history entry on the web). Escape, Back and the scrim close it, as every sheet does.
 */
export function AllFriendsSheet({
  visible,
  friends,
  status = 'ready',
  complete = true,
  onClose,
  onCross,
  onRetry,
}: {
  readonly visible: boolean;
  readonly friends: readonly OuterFriend[];
  readonly status?: OuterStatus;
  readonly complete?: boolean;
  readonly onClose: () => void;
  readonly onCross: (handle: string) => void;
  readonly onRetry?: () => void;
}) {
  return (
    <BottomSheet
      visible={visible}
      title={allFriendsLabel(friends.length, status, complete)}
      onClose={onClose}
      fit
      testID="outer-friends-sheet"
    >
      <AllFriendsList
        friends={friends}
        status={status}
        complete={complete}
        onChoose={(handle) => closeThen(onClose, () => onCross(handle))}
        {...(onRetry === undefined ? {} : { onRetry })}
      />
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  list: { gap: spacing[2], flexShrink: 1 },
  notice: { gap: spacing[2] },
  scroll: { flexShrink: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    minHeight: target.comfortable,
    paddingVertical: spacing[2],
    borderBottomWidth: borderWidth.hairline,
    borderBottomColor: content.rule,
  },
  disc: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: palette.focus,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: { flex: 1 },
});
