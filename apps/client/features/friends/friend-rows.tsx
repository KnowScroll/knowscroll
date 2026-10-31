import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { AvailabilityWord, FriendsPair } from '@knowscroll/client-core';
import { borderWidth, content, elevation, radius, spacing } from '@knowscroll/design-tokens';
import { BottomSheet, Button, IconButton, Tag, Text } from '@knowscroll/ui';
import { closeThen } from '../../platform/close-then';
import { PersonAvatar } from '../conversations/person-avatar';

export type PairOperation = 'accept' | 'decline' | 'cancel' | 'remove' | 'block' | 'unblock';
export type PairCommand = (
  operation: PairOperation,
  input: { peerPersonId: string; expectedPairRevision: number; requestId?: string },
) => void;

export interface FriendRowProps {
  readonly pair: FriendsPair;
  readonly disabled: boolean;
  readonly onCommand: PairCommand;
  /** The word the friend shows to friends, only while its lease holds. */
  readonly availability?: AvailabilityWord | undefined;
  /** Opens the friend's universe (U06). The server decides whether anything is shown. */
  readonly onVisit?: (() => void) | undefined;
}

function commandOf(pair: FriendsPair, onCommand: PairCommand) {
  const input = { peerPersonId: pair.peer.personId, expectedPairRevision: pair.pairRevision };
  return (operation: PairOperation) => () =>
    onCommand(operation, { ...input, ...('requestId' in pair ? { requestId: pair.requestId } : {}) });
}

/** The second line of a friend: the availability word with its dot, or the handle when none is shown. */
function FriendLine({ pair, availability }: { readonly pair: FriendsPair; readonly availability?: AvailabilityWord }) {
  if (availability === undefined)
    return (
      <Text variant="meta" color={content.ink2} numberOfLines={1}>
        Friends · @{pair.peer.handle}
      </Text>
    );
  return (
    <View style={styles.line}>
      <View style={[styles.dot, availability === 'online' ? styles.online : null]} aria-hidden />
      <Text variant="metaS" color={content.freshInk} numberOfLines={1}>
        {availability === 'online' ? 'Friends · Online' : 'Friends · Recently active'}
      </Text>
    </View>
  );
}

/** What a row's ⋯ offers, by relationship. Each item is one pair command or a visit; none is on the row itself. */
function RowMenu({
  pair,
  name,
  disabled,
  onCommand,
  onVisit,
}: Pick<FriendRowProps, 'pair' | 'disabled' | 'onCommand' | 'onVisit'> & { readonly name: string }) {
  const [open, setOpen] = useState(false);
  const run = commandOf(pair, onCommand);
  const choose = (action: () => void) => () => {
    setOpen(false);
    action();
  };
  // A visit opens another screen, so the sheet is closed first and the screen opens once its history entry is gone.
  const visit = (action: () => void) => () => closeThen(() => setOpen(false), action);
  return (
    <>
      <IconButton icon="more" label={`Options for ${name}`} variant="plain" onPress={() => setOpen(true)} />
      <BottomSheet visible={open} title={name} onClose={() => setOpen(false)}>
        <View style={styles.menu}>
          {pair.state === 'friends' && onVisit ? (
            <Button
              label={`Visit ${name}’s universe`}
              variant="primary"
              fullWidth
              disabled={disabled}
              onPress={visit(onVisit)}
            />
          ) : null}
          {pair.state === 'friends' ? (
            <Button
              label={`Remove ${name}`}
              fullWidth
              variant="ghost"
              disabled={disabled}
              onPress={choose(run('remove'))}
            />
          ) : null}
          {pair.state === 'outgoing' ? (
            <Button
              label={`Cancel request to ${name}`}
              fullWidth
              variant="ghost"
              disabled={disabled}
              onPress={choose(run('cancel'))}
            />
          ) : null}
          {pair.state !== 'blocked' && pair.state !== 'none' ? (
            <Button
              label={`Block ${name}`}
              fullWidth
              variant="ghost"
              disabled={disabled}
              onPress={choose(run('block'))}
            />
          ) : null}
        </View>
      </BottomSheet>
    </>
  );
}

/** One friend, as C01's rows draw people: avatar, name, a line, and ⋯ for what can be done. */
export function FriendRow(props: FriendRowProps) {
  const { pair, availability } = props;
  const name = pair.peer.displayName;
  return (
    <View style={styles.row} role="listitem">
      <PersonAvatar person={pair.peer} size={44} />
      <View style={styles.text}>
        <Text variant="ui" numberOfLines={1}>
          {name}
        </Text>
        <FriendLine pair={pair} {...(availability === undefined ? {} : { availability })} />
      </View>
      <RowMenu {...props} name={name} />
    </View>
  );
}

/** Someone asking to be a friend: a card with Accept and Decline, the one place a request is answered. */
export function IncomingCard({ pair, disabled, onCommand }: FriendRowProps) {
  const name = pair.peer.displayName;
  const run = commandOf(pair, onCommand);
  return (
    <View style={styles.card} role="listitem">
      <View style={styles.cardTop}>
        <PersonAvatar person={pair.peer} size={44} />
        <View style={styles.text}>
          <Text variant="ui" numberOfLines={1}>
            {name}
          </Text>
          <Text variant="meta" color={content.ink2} numberOfLines={1}>
            @{pair.peer.handle} · asking to be your friend
          </Text>
        </View>
        <RowMenu pair={pair} name={name} disabled={disabled} onCommand={onCommand} onVisit={undefined} />
      </View>
      <View style={styles.answers}>
        <View style={styles.answer}>
          <Button
            label="Accept"
            accessibilityLabel={`Accept ${name}`}
            variant="primary"
            fullWidth
            disabled={disabled}
            onPress={run('accept')}
          />
        </View>
        <View style={styles.answer}>
          <Button
            label="Decline"
            accessibilityLabel={`Decline ${name}`}
            fullWidth
            disabled={disabled}
            onPress={run('decline')}
          />
        </View>
      </View>
    </View>
  );
}

/** A request this person sent and nobody has answered: a dashed avatar and a Pending tag; ⋯ cancels it. */
export function SentRow(props: FriendRowProps) {
  const { pair } = props;
  const name = pair.peer.displayName;
  return (
    <View style={styles.row} role="listitem">
      <View style={styles.pendingAvatar}>
        <PersonAvatar person={pair.peer} size={40} />
      </View>
      <View style={styles.text}>
        <Text variant="ui" numberOfLines={1}>
          {name}
        </Text>
        <Text variant="meta" color={content.ink2} numberOfLines={1}>
          @{pair.peer.handle} · invite sent
        </Text>
      </View>
      <Tag variant="neutral" label="Pending" />
      <RowMenu {...props} name={name} />
    </View>
  );
}

/** Someone this person blocked: what blocking means, and Unblock. */
export function BlockedRow({ pair, disabled, onCommand }: FriendRowProps) {
  const name = pair.peer.displayName;
  return (
    <View style={styles.row} role="listitem">
      <PersonAvatar person={pair.peer} size={44} />
      <View style={styles.text}>
        <Text variant="ui" numberOfLines={1}>
          {name}
        </Text>
        <Text variant="meta" color={content.ink2} numberOfLines={2}>
          @{pair.peer.handle} · Can’t message, invite or visit you
        </Text>
      </View>
      <Button
        label="Unblock"
        accessibilityLabel={`Unblock ${name}`}
        size="sm"
        disabled={disabled}
        onPress={commandOf(pair, onCommand)('unblock')}
      />
    </View>
  );
}

/** A person the caller found by handle, drawn as the row their relationship calls for (nothing when there is none). */
export function PairRow(props: FriendRowProps) {
  switch (props.pair.state) {
    case 'friends':
      return <FriendRow {...props} />;
    case 'incoming':
      return <IncomingCard {...props} />;
    case 'outgoing':
      return <SentRow {...props} />;
    case 'blocked':
      return <BlockedRow {...props} />;
    case 'none':
      return null;
  }
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    paddingVertical: spacing[3],
    borderBottomWidth: borderWidth.hairline,
    borderBottomColor: content.rule,
  },
  text: { flex: 1, minWidth: 0, gap: spacing[0.5] },
  line: { flexDirection: 'row', alignItems: 'center', gap: spacing[1] },
  dot: { width: 8, height: 8, borderRadius: 4, borderWidth: borderWidth.light, borderColor: content.fresh },
  online: { backgroundColor: content.fresh },
  menu: { gap: spacing[3], paddingBottom: spacing[2] },
  card: {
    gap: spacing[3],
    padding: spacing[3],
    marginVertical: spacing[2],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.panel,
    backgroundColor: content.paper,
    boxShadow: elevation.hint,
  },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
  answers: { flexDirection: 'row', gap: spacing[3] },
  answer: { flex: 1 },
  pendingAvatar: { opacity: 0.7 },
});
