import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import type { AccountScope, RoomController, RoomState } from '@knowscroll/client-core';
import type { RoomInhabitant, RoomView } from '@knowscroll/contracts';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { Button, Icon, Text } from '@knowscroll/ui';
import { AiLabel, ModeratorLabel } from './ai-label';
import { ReportedMessages } from './reported-messages';

type Member = Extract<RoomView, { status: 'member' }>;

/** The words each join rule goes by. */
export const RULE_WORDS = {
  open: 'Open to everyone',
  friends_of_members: 'Open to friends of members',
  invite_only: 'Invite-only',
} as const;

/** The room's written guidelines, folded until asked for. */
export function Guidelines({ text }: { readonly text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.guidelines}>
      <Pressable role="button" aria-expanded={open} onPress={() => setOpen(!open)} style={styles.guidelinesToggle}>
        <Text variant="ui">Room guidelines</Text>
        <Icon name={open ? 'chevronUp' : 'chevronDown'} size={18} color={content.ink} />
      </Pressable>
      {open ? (
        <Text variant="bodyS" color={content.ink2}>
          {text}
        </Text>
      ) : null}
    </View>
  );
}

/** Who the room has beside people: a moderator when there is one, and the labelled AI inhabitants. */
export function WhoIsHere({
  hasModerator,
  inhabitants,
  stacked,
}: {
  readonly hasModerator: boolean;
  readonly inhabitants: readonly RoomInhabitant[];
  /** Each label above its words, for a narrow column (D04's left pane). */
  readonly stacked?: boolean;
}) {
  return (
    <View style={styles.who} role="list" accessibilityLabel="Who is here to help">
      <Text variant="monoXs" color={content.ink2}>
        Who’s here to help
      </Text>
      {hasModerator ? (
        <View role="listitem" style={[styles.whoRow, stacked === true ? styles.whoRowStacked : null]}>
          <ModeratorLabel />
          <Text variant="bodyS">Keeps the discussion on track</Text>
        </View>
      ) : null}
      {inhabitants.map((entry) => (
        <View
          key={entry.inhabitant}
          role="listitem"
          style={[styles.whoRow, stacked === true ? styles.whoRowStacked : null]}
        >
          <AiLabel label={entry.label} />
          <Text variant="bodyS">{`${entry.name}: ${entry.blurb.charAt(0).toLowerCase()}${entry.blurb.slice(1)}`}</Text>
        </View>
      ))}
      {inhabitants.length === 0 ? null : (
        <Text variant="meta" color={content.ink2}>
          AI inhabitants are labelled and never pretend to be people.
        </Text>
      )}
    </View>
  );
}

/** A moderator's pause and resume, and the reports on their room's messages. Nothing here changes anyone's universe. */
export function ModeratorTools({
  scope,
  view,
  controller,
  state,
}: {
  readonly scope: AccountScope;
  readonly view: Member;
  readonly controller: RoomController;
  readonly state: RoomState;
}) {
  return (
    <View style={styles.moderation}>
      <Text variant="metaS" color={content.freshInk}>
        Moderator tools
      </Text>
      {view.room.status === 'open' ? (
        <Button
          label="Pause the room"
          size="sm"
          busy={state.working}
          onPress={() => void controller.moderate({ kind: 'pause' })}
        />
      ) : view.room.status === 'paused' ? (
        <Button
          label="Resume the room"
          size="sm"
          busy={state.working}
          onPress={() => void controller.moderate({ kind: 'resume' })}
        />
      ) : null}
      <Text variant="meta" color={content.ink2}>
        Pinning and removing messages are on each discussion. Nothing here changes anyone’s universe.
      </Text>
      <ReportedMessages scope={scope} roomId={view.room.roomId} />
    </View>
  );
}

const styles = StyleSheet.create({
  who: { gap: spacing[2], paddingTop: spacing[2], borderTopWidth: borderWidth.hairline, borderTopColor: content.rule },
  whoRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[3], minHeight: 44 },
  whoRowStacked: {
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: spacing['0.5'],
    minHeight: 0,
    paddingVertical: spacing[1],
  },
  guidelines: { gap: spacing[1] },
  guidelinesToggle: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  moderation: { gap: spacing[2], padding: spacing[3], borderRadius: radius.card, backgroundColor: content.freshTint },
});
