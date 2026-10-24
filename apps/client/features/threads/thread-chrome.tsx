import { StyleSheet, View } from 'react-native';
import type { ContentThreadState } from '@knowscroll/client-core';
import type { ConversationContentProjection, ThreadParticipant } from '@knowscroll/contracts';
import { borderWidth, content, layout, radius, spacing } from '@knowscroll/design-tokens';
import { BottomSheet, Button, IconButton, Tag, Text } from '@knowscroll/ui';
import { PersonAvatar } from '../conversations/person-avatar';

/** The title a thread goes by: the name its starter gave it, else the title of what it is about. */
export function threadTitle(state: Pick<ContentThreadState, 'name' | 'root'>): string {
  if (state.name !== undefined) return state.name;
  const root: ConversationContentProjection | undefined = state.root;
  if (root?.status === 'available') return root.metadata.title;
  if (root?.status === 'corrected') return root.current.metadata.title;
  return 'Shared thread';
}

/** C04's top bar: Back, the title, who is in it, and the people and options controls. */
export function ThreadHeader({
  title,
  people,
  onBack,
  onMap,
  onPeople,
  onMenu,
}: {
  readonly title: string;
  /** Names of the participants, for the line under the title. */
  readonly people: string | undefined;
  readonly onBack: () => void;
  /** Offered only once the thread has several branches (X04); never for a first exploration. */
  readonly onMap?: (() => void) | undefined;
  readonly onPeople: (() => void) | undefined;
  readonly onMenu: (() => void) | undefined;
}) {
  return (
    <View style={styles.header}>
      <IconButton icon="back" label="Back" onPress={onBack} />
      <View style={styles.title}>
        {/* With the Map beside it the title has less room: it wraps rather than losing its end. */}
        <Text variant="title" heading={1} numberOfLines={onMap === undefined ? 1 : 2}>
          {title}
        </Text>
        {people === undefined ? null : (
          <Text variant="meta" color={content.ink2} numberOfLines={1}>
            {people}
          </Text>
        )}
      </View>
      {onMap === undefined ? null : (
        <Button label="Map" size="sm" variant="ghost" onPress={onMap} testID="thread-map-button" />
      )}
      {onPeople === undefined ? null : <IconButton icon="person" label="People in this thread" onPress={onPeople} />}
      {onMenu === undefined ? null : <IconButton icon="more" label="Thread options" onPress={onMenu} />}
    </View>
  );
}

/** Who is in the thread: names only, the starter marked, invitations not yet answered said in words. */
export function PeopleSheet({
  visible,
  participants,
  onClose,
}: {
  readonly visible: boolean;
  readonly participants: readonly ThreadParticipant[];
  readonly onClose: () => void;
}) {
  return (
    <BottomSheet visible={visible} title="People in this thread" onClose={onClose}>
      <View role="list" style={styles.people}>
        {participants.map((participant) => (
          <View key={participant.person.personId} role="listitem" style={styles.person}>
            <PersonAvatar person={participant.person} size={40} />
            <View style={styles.title}>
              <Text variant="ui" numberOfLines={1}>
                {participant.person.displayName}
                {participant.you ? ' (you)' : ''}
              </Text>
              <Text variant="meta" color={content.ink2} numberOfLines={1}>
                @{participant.person.handle}
              </Text>
            </View>
            {participant.role === 'starter' ? <Tag label="Started it" /> : null}
            {participant.joined ? null : <Tag label="Invited" />}
          </View>
        ))}
      </View>
      <Text variant="meta" color={content.ink2}>
        Everyone keeps their own place in the episodes. Nobody sees where anyone else is.
      </Text>
    </BottomSheet>
  );
}

/** What the person can do with the thread itself. */
export function OptionsSheet({
  visible,
  onLeave,
  onClose,
}: {
  readonly visible: boolean;
  readonly onLeave: () => void;
  readonly onClose: () => void;
}) {
  return (
    <BottomSheet visible={visible} title="Thread options" onClose={onClose}>
      <View style={styles.options}>
        <Text variant="bodyS">
          Leaving ends your place here. What you wrote stays, and you can only come back if someone invites you again.
        </Text>
        <Button label="Leave this thread" variant="danger" onPress={onLeave} />
        <Button label="Cancel" variant="ghost" onPress={onClose} />
      </View>
    </BottomSheet>
  );
}

/** The invitation, before the person has joined: what it is about and who asked, nothing of the conversation. */
export function InvitationView({
  state,
  onJoin,
  onDecline,
}: {
  readonly state: ContentThreadState;
  readonly onJoin: () => void;
  readonly onDecline: () => void;
}) {
  const root = state.root;
  const metadata =
    root?.status === 'available' ? root.metadata : root?.status === 'corrected' ? root.current.metadata : undefined;
  const inviter = state.invitedBy;
  return (
    <View style={styles.invitation}>
      <View style={styles.invitationCard}>
        {inviter === undefined ? null : <PersonAvatar person={inviter} size={44} />}
        <Text variant="title" heading={1}>
          {inviter === undefined ? 'You’re invited' : `${inviter.displayName} invited you to explore this`}
        </Text>
        {metadata === undefined ? (
          <Text variant="bodyS" color={content.ink2}>
            This isn’t available any more, but you can still join the conversation.
          </Text>
        ) : (
          <>
            <Tag label={metadata.kind === 'reel' ? 'Reel' : 'Scroll'} />
            <Text variant="ui">{metadata.title}</Text>
            {metadata.summary === '' ? null : (
              <Text variant="bodyS" color={content.ink2} numberOfLines={4}>
                {metadata.summary}
              </Text>
            )}
          </>
        )}
        <Text variant="meta" color={content.ink2}>
          Watch or read it in any order, at your own pace. Joining does not tell anyone what you have seen.
        </Text>
      </View>
      <Button label="Join this thread" variant="primary" fullWidth busy={state.responding} onPress={onJoin} />
      <Button label="Ignore" variant="default" fullWidth disabled={state.responding} onPress={onDecline} />
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    paddingHorizontal: layout.gutter,
    paddingVertical: spacing[2],
    borderBottomWidth: borderWidth.regular,
    borderBottomColor: content.ink,
  },
  title: { flex: 1 },
  people: { gap: spacing[2] },
  person: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
  options: { gap: spacing[3] },
  invitation: {
    padding: layout.gutter,
    gap: spacing[3],
    width: '100%',
    maxWidth: layout.measureDesktop,
    alignSelf: 'center',
  },
  invitationCard: {
    gap: spacing[3],
    padding: spacing[5],
    alignItems: 'flex-start',
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.panel,
    backgroundColor: content.paper,
  },
});
