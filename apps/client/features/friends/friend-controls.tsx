import type { ComponentProps } from 'react';
import { StyleSheet, View } from 'react-native';
import type { AvailabilityWord, FriendsOutput } from '@knowscroll/client-core';
import { borderWidth, content, radius, spacing, target } from '@knowscroll/design-tokens';
import { Button, Text } from '@knowscroll/ui';

/** Bound even an eighty-character public name at narrow widths or larger text. */
export function FriendButton(props: ComponentProps<typeof Button>) {
  return (
    <View style={styles.button}>
      <Button {...props} fullWidth />
    </View>
  );
}

type Pair = Extract<FriendsOutput<'pair'>, { status: 'available' }>['pair'];
type PairOperation = 'accept' | 'decline' | 'cancel' | 'remove' | 'block' | 'unblock';
export function FriendIdentity({ person }: { readonly person: Pair['peer'] }) {
  return (
    <View style={styles.identity}>
      <View style={styles.avatar} aria-hidden importantForAccessibility="no-hide-descendants">
        <Text variant="ui">{[...person.displayName][0]}</Text>
      </View>
      <View style={styles.name}>
        <Text variant="ui">{person.displayName}</Text>
        <Text variant="bodyS" color={content.ink2}>
          @{person.handle}
        </Text>
      </View>
    </View>
  );
}

/** Controls bind a current pure pair/page read. Acceptance never changes the displayed pair. */
export function FriendControls({
  pair,
  disabled,
  onCommand,
  availability,
  onVisit,
}: {
  readonly pair: Pair;
  readonly disabled: boolean;
  /** What the friend lets this person see, while it is fresh; nothing when hidden, expired or unknown. */
  readonly availability?: AvailabilityWord | undefined;
  /** Opens the friend's universe (U06). The server decides whether anything is shown. */
  readonly onVisit?: () => void;
  readonly onCommand: (
    operation: PairOperation,
    input: { peerPersonId: string; expectedPairRevision: number; requestId?: string },
  ) => void;
}) {
  const input = { peerPersonId: pair.peer.personId, expectedPairRevision: pair.pairRevision };
  const action = (operation: PairOperation) => () =>
    onCommand(operation, {
      ...input,
      ...('requestId' in pair ? { requestId: pair.requestId } : {}),
    });
  return (
    <View style={styles.card}>
      <FriendIdentity person={pair.peer} />
      <Text variant="bodyS" color={content.ink2}>
        {pair.state === 'friends'
          ? availability === undefined
            ? 'Friends'
            : `Friends · ${availability === 'online' ? 'Online' : 'Recently active'}`
          : pair.state === 'incoming'
            ? 'Asking to be your friend'
            : pair.state === 'outgoing'
              ? 'Request pending'
              : pair.state === 'blocked'
                ? 'Blocked by you'
                : 'No current friendship'}
      </Text>
      <View style={styles.actions}>
        {pair.state === 'incoming' ? (
          <>
            <FriendButton
              label={`Accept ${pair.peer.displayName}`}
              variant="primary"
              disabled={disabled}
              onPress={action('accept')}
            />
            <FriendButton
              label={`Decline ${pair.peer.displayName}`}
              variant="ghost"
              disabled={disabled}
              onPress={action('decline')}
            />
          </>
        ) : null}
        {pair.state === 'outgoing' ? (
          <FriendButton
            label={`Cancel request to ${pair.peer.displayName}`}
            variant="ghost"
            disabled={disabled}
            onPress={action('cancel')}
          />
        ) : null}
        {pair.state === 'friends' && onVisit ? (
          <FriendButton
            label={`Visit ${pair.peer.displayName}’s universe`}
            variant="primary"
            disabled={disabled}
            onPress={onVisit}
          />
        ) : null}
        {pair.state === 'friends' ? (
          <FriendButton
            label={`Remove ${pair.peer.displayName}`}
            variant="ghost"
            disabled={disabled}
            onPress={action('remove')}
          />
        ) : null}
        {pair.state === 'blocked' ? (
          <FriendButton
            label={`Unblock ${pair.peer.displayName}`}
            variant="ghost"
            disabled={disabled}
            onPress={action('unblock')}
          />
        ) : (
          <FriendButton
            label={`Block ${pair.peer.displayName}`}
            variant="ghost"
            disabled={disabled}
            onPress={() => onCommand('block', input)}
          />
        )}
      </View>
    </View>
  );
}

export const friendsStyles = StyleSheet.create({
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[3] },
  card: {
    gap: spacing[3],
    padding: spacing[4],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.panel,
    backgroundColor: content.paper,
  },
});
const styles = StyleSheet.create({
  ...friendsStyles,
  button: { maxWidth: '100%', minWidth: 0, flexShrink: 1 },
  identity: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
  name: { flex: 1, minWidth: 0, gap: spacing[1] },
  avatar: {
    width: target.minimum,
    height: target.minimum,
    borderRadius: radius.pill,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.paper2,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
