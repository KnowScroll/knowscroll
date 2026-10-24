import { useEffect } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import type { AvailabilityWord, SendStatus, ShareSession, ShareState } from '@knowscroll/client-core';
import type { DirectConversationRef } from '@knowscroll/contracts';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { Banner, Button, Icon, Text, useTypeStyle } from '@knowscroll/ui';
import { FriendPicker } from './friend-picker';
import { StepHeader } from './step-header';

function NoteField({
  value,
  onChange,
  disabled,
}: {
  readonly value: string;
  readonly onChange: (text: string) => void;
  readonly disabled: boolean;
}) {
  const type = useTypeStyle('bodyS');
  return (
    <View style={styles.field}>
      <Text variant="uiS">Add a note (optional)</Text>
      <TextInput
        accessibilityLabel="Add a note (optional)"
        value={value}
        onChangeText={onChange}
        editable={!disabled}
        multiline
        maxLength={500}
        allowFontScaling={false}
        style={[styles.input, { fontFamily: type.fontFamily, fontSize: type.fontSize, lineHeight: type.lineHeight }]}
      />
    </View>
  );
}

/** Why the last send did not go through, in words that say whether anything was sent. */
function SendNotice({ send }: { send: SendStatus }) {
  if (send.status === 'unconfirmed')
    return (
      <Banner
        kind="error"
        lead="Couldn’t confirm it was sent."
        message="Retrying sends the same message, so it can’t arrive twice."
      />
    );
  if (send.status === 'unavailable')
    return (
      <Banner kind="error" lead="This can’t be sent right now." message="Choose someone else or try again later." />
    );
  if (send.status === 'failed')
    return <Banner kind="error" lead="Couldn’t send." message="Nothing was sent. Try again." />;
  return null;
}

function sendLabel(send: SendStatus, chosenName: string | undefined): string {
  if (send.status === 'unconfirmed') return 'Retry';
  return chosenName === undefined ? 'Choose a friend' : `Send to ${chosenName}`;
}

/** "Sent" is shown only once the server has answered with its receipt. */
function SentReceipt({ name, onOpen }: { readonly name: string; readonly onOpen: () => void }) {
  return (
    <View style={styles.receipt} accessibilityLiveRegion="polite">
      <View style={styles.sent}>
        <Icon name="check" size={18} color={content.freshInk} />
        <Text variant="ui">Sent to {name}</Text>
      </View>
      <Button label="Open chat" size="sm" onPress={onOpen} />
    </View>
  );
}

export interface SendToFriendProps {
  readonly session: ShareSession;
  readonly state: ShareState;
  readonly onBack: () => void;
  readonly onClose: () => void;
  readonly onOpenConversation: (conversation: DirectConversationRef) => void;
  readonly availabilityOf: (personId: string) => AvailabilityWord | undefined;
}

/** H01's second view: choose a friend, add a note, send, and open the chat once it is sent. */
export function SendToFriend({
  session,
  state,
  onBack,
  onClose,
  onOpenConversation,
  availabilityOf,
}: SendToFriendProps) {
  const { targets, send } = state;
  useEffect(() => {
    if (targets.status === 'loading' && targets.items.length === 0) void session.loadTargets();
  }, [session, targets.status, targets.items.length]);

  const chosen = targets.items.find((entry) => entry.person.personId === state.selected);
  const sending = send.status === 'sending';
  const locked = sending || send.status === 'unconfirmed' || send.status === 'sent';
  return (
    <View style={styles.section}>
      <StepHeader title="Send to a conversation" onBack={onBack} backDisabled={locked} />
      {send.status === 'sent' ? (
        <SentReceipt name={send.target.person.displayName} onOpen={() => onOpenConversation(send.conversation)} />
      ) : (
        <>
          <FriendPicker
            targets={targets}
            selected={state.selected}
            locked={locked}
            onSelect={session.select}
            availabilityOf={availabilityOf}
          />
          {chosen === undefined ? null : <NoteField value={state.note} onChange={session.setNote} disabled={locked} />}
          <SendNotice send={send} />
          <Button
            label={sendLabel(send, chosen?.person.displayName)}
            variant="primary"
            fullWidth
            busy={sending}
            busyLabel="Sending"
            disabled={chosen === undefined}
            onPress={() => void session.send()}
          />
        </>
      )}
      <Button label={send.status === 'sent' ? 'Done' : 'Cancel'} fullWidth variant="ghost" onPress={onClose} />
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: spacing[3] },
  sent: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
  field: { gap: spacing[1] },
  input: {
    minHeight: 48,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.md,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    color: content.ink,
    backgroundColor: content.paper,
  },
  receipt: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing[3],
    padding: spacing[3],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.md,
    backgroundColor: content.freshTint,
  },
});
