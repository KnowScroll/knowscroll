import type { ReactNode } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import type { ContentThreadState } from '@knowscroll/client-core';
import type { ConversationContentProjection, ThreadParticipant } from '@knowscroll/contracts';
import { borderWidth, content, layout, radius, spacing } from '@knowscroll/design-tokens';
import { BottomSheet, Button, IconButton, Tag, Text, useTalkTheme } from '@knowscroll/ui';
import { PersonAvatar } from '../conversations/person-avatar';

/** The header strip's height on a thread (T3: 64 px on a conversation, 72 px on a thread). */
const HEADER_HEIGHT = 72;

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
  onMenu,
}: {
  readonly title: string;
  /** Names of the participants, for the line under the title. */
  readonly people: string | undefined;
  readonly onBack: () => void;
  /** Offered only once the thread has several branches (X04); never for a first exploration. */
  readonly onMap?: (() => void) | undefined;
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
      {onMenu === undefined ? null : <IconButton icon="more" label="Thread options" onPress={onMenu} />}
    </View>
  );
}

/**
 * The small line above the title: what this is and how big, e.g. "A THREAD · 3 PARTS · 4 PEOPLE". A
 * phone strip has no room for the people, who are listed under Series.
 */
export function threadEyebrow(
  state: Pick<ContentThreadState, 'sequence' | 'episodes' | 'participants'>,
  withPeople: boolean,
): string {
  const count = state.episodes.length;
  const noun = state.sequence === 'series' ? 'PART' : 'ITEM';
  const people = state.participants.length;
  return [
    'A THREAD',
    count === 0 ? undefined : `${String(count)} ${noun}${count === 1 ? '' : 'S'}`,
    !withPeople || people === 0 ? undefined : `${String(people)} ${people === 1 ? 'PERSON' : 'PEOPLE'}`,
  ]
    .filter((part): part is string => part !== undefined)
    .join(' · ');
}

/**
 * C04's header strip on a thread (T3): 72 px, so the conversation keeps the screen. Back, the title under a small
 * line saying what this is (or, in a series, under its part worlds with the faces of the members on them), and
 * the thread's options. On a phone "Series" pulls the parts down as a sheet; beside the conversation (desktop)
 * the parts are always on show and the button is absent.
 */
export function ThreadStrip({
  title,
  eyebrow,
  worlds,
  onBack,
  series,
  onMenu,
  onLayout,
}: {
  readonly title: string;
  readonly eyebrow: string | undefined;
  /** The part worlds, drawn where the small line would be: a series says how long it is by showing its parts. */
  readonly worlds?: ReactNode;
  readonly onBack: () => void;
  /** Pulls the parts down from this header; absent where they are always shown. */
  readonly series?: { readonly open: boolean; readonly onPress: () => void } | undefined;
  readonly onMenu: (() => void) | undefined;
  /** Reports the strip's height, so a sheet can hang from its bottom edge. */
  readonly onLayout?: ((event: LayoutChangeEvent) => void) | undefined;
}) {
  const theme = useTalkTheme();
  return (
    <View style={[styles.stripGround, { backgroundColor: theme.ground }]} onLayout={onLayout} testID="thread-header">
      <View style={[styles.strip, { backgroundColor: theme.bar.fill, borderColor: theme.bar.edge }]}>
        <IconButton icon="back" label="Back" variant="onSpace" size={44} onPress={onBack} />
        <View style={styles.title}>
          {worlds !== undefined || eyebrow === undefined ? null : (
            <Text variant="monoXs" color={theme.textQuiet} numberOfLines={1}>
              {eyebrow}
            </Text>
          )}
          <Text variant="ui" heading={1} numberOfLines={1} color={theme.bar.text}>
            {title}
          </Text>
          {worlds}
        </View>
        {series === undefined ? null : (
          <Button
            label="Series"
            size="sm"
            variant={series.open ? 'continue' : 'space'}
            icon={series.open ? 'chevronUp' : 'chevronDown'}
            iconPosition="trailing"
            accessibilityHint="Pulls down the parts of this thread"
            onPress={series.onPress}
            testID="thread-series-button"
          />
        )}
        {onMenu === undefined ? null : (
          <IconButton icon="more" label="Thread options" variant="onSpace" size={44} onPress={onMenu} />
        )}
      </View>
    </View>
  );
}

/** Who is in the thread: names only, the starter marked, invitations not yet answered said in words. */
export function ThreadPeople({ participants }: { readonly participants: readonly ThreadParticipant[] }) {
  return (
    <View style={styles.people}>
      <Text variant="monoXs" color={content.ink2}>
        PEOPLE
      </Text>
      <View role="list" accessibilityLabel="People in this thread" style={styles.people}>
        {participants.map((participant) => (
          <View key={participant.person.personId} role="listitem" style={styles.person}>
            <PersonAvatar person={participant.person} size={32} />
            <View style={styles.title}>
              <Text variant="uiS" numberOfLines={1}>
                {participant.person.displayName}
                {participant.you ? ' (you)' : ''}
              </Text>
              <Text variant="metaS" color={content.ink2} numberOfLines={1}>
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
    </View>
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
  /** The sky behind the glass bar: 8 px around it, so the strip is 72 px (T3 kit) and the glass 64. */
  stripGround: { paddingHorizontal: spacing[2], paddingVertical: spacing[1], minHeight: HEADER_HEIGHT },
  strip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    paddingHorizontal: layout.gutter - spacing[2],
    minHeight: HEADER_HEIGHT - 2 * spacing[1],
    borderRadius: 24,
    borderWidth: 1,
  },
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
