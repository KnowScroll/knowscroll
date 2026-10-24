import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import type { PublicPersonRef } from '@knowscroll/contracts';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { Button, Icon, IconButton, Text } from '@knowscroll/ui';
import { PersonAvatar } from '../conversations/person-avatar';
import { FriendField } from './friend-field';
import { InviteLinkCard, type InviteLinkCardProps } from './invite-link-card';

/** A person found by handle or invite, with the one action that asks them to be a friend. */
function PersonCard({
  person,
  sendLabel,
  note,
  disabled,
  onSend,
}: {
  readonly person: PublicPersonRef;
  readonly sendLabel: string;
  readonly note?: string;
  readonly disabled: boolean;
  readonly onSend: () => void;
}) {
  return (
    <View style={styles.found}>
      <View style={styles.foundTop}>
        <PersonAvatar person={person} size={44} />
        <View style={styles.foundText}>
          <Text variant="ui" numberOfLines={1}>
            {person.displayName}
          </Text>
          <Text variant="meta" color={content.ink2} numberOfLines={1}>
            @{person.handle}
          </Text>
        </View>
        <Button
          label="Send invite"
          accessibilityLabel={sendLabel}
          variant="primary"
          size="sm"
          disabled={disabled}
          onPress={onSend}
        />
      </View>
      {note === undefined ? null : (
        <Text variant="meta" color={content.ink2}>
          {note}
        </Text>
      )}
    </View>
  );
}

export interface AddFriendPanelProps {
  readonly onClose: () => void;
  /** Disabled while a command or read is in flight. */
  readonly disabled: boolean;
  readonly inputsDisabled: boolean;
  readonly handle: {
    readonly value: string;
    readonly onChange: (value: string) => void;
    readonly canFind: boolean;
    readonly onFind: () => void;
    readonly searching: boolean;
    /** The person found by exactly that handle, if any. */
    readonly found: PublicPersonRef | undefined;
    readonly unavailable: boolean;
    /** Asking is possible: a claimed profile and no relationship yet. */
    readonly canSend: boolean;
    readonly onSend: () => void;
    /** What the existing relationship with the found person is, when there is one, drawn as a row. */
    readonly existing: ReactNode;
  };
  readonly link: InviteLinkCardProps;
  readonly pasted: {
    readonly value: string;
    readonly onChange: (value: string) => void;
    readonly onCheck: () => void;
    readonly checking: boolean;
    readonly unavailable: boolean;
    readonly issuer: PublicPersonRef | undefined;
    readonly canSend: boolean;
    readonly onSend: () => void;
  };
}

/**
 * F01 "Add a friend": their handle, the found person with Send invite, "or", your own invite link,
 * and the promise that no contacts are uploaded. A pasted invitation is checked before anything is
 * asked: checking sends nothing, and the person still chooses whether to accept.
 */
export function AddFriendPanel({ onClose, disabled, inputsDisabled, handle, link, pasted }: AddFriendPanelProps) {
  return (
    <View style={styles.panel}>
      <View style={styles.header}>
        <IconButton icon="close" label="Back to friends" variant="plain" onPress={onClose} />
        <Text variant="title" heading={2}>
          Add a friend
        </Text>
      </View>
      <FriendField
        label="Their handle"
        value={handle.value}
        placeholder="@their.handle"
        maxLength={24}
        onChange={handle.onChange}
        disabled={inputsDisabled}
        onSubmit={handle.onFind}
      />
      <Button label="Find handle" variant="ghost" disabled={disabled || !handle.canFind} onPress={handle.onFind} />
      {handle.searching ? <Text variant="bodyS">Checking handle…</Text> : null}
      {handle.unavailable ? (
        <Text variant="bodyS">This person is unavailable. Check the handle or try again.</Text>
      ) : null}
      {handle.found ? (
        <PersonCard
          person={handle.found}
          sendLabel={`Send invite to ${handle.found.displayName}`}
          disabled={!handle.canSend}
          onSend={handle.onSend}
        />
      ) : null}
      {handle.existing}
      <View style={styles.or} aria-hidden>
        <View style={styles.rule} />
        <Text variant="monoXs" color={content.ink2}>
          or
        </Text>
        <View style={styles.rule} />
      </View>
      <InviteLinkCard {...link} />
      <View style={styles.paste}>
        <FriendField
          label="Friend invite link"
          value={pasted.value}
          maxLength={2048}
          secret
          onChange={pasted.onChange}
          disabled={inputsDisabled}
          onSubmit={pasted.onCheck}
        />
        <Button label="Check invitation" variant="ghost" disabled={disabled} onPress={pasted.onCheck} />
        {pasted.checking ? <Text variant="bodyS">Checking invitation…</Text> : null}
        {pasted.unavailable ? (
          <Text variant="bodyS">This invitation is unavailable. It may no longer work.</Text>
        ) : null}
        {pasted.issuer ? (
          <PersonCard
            person={pasted.issuer}
            sendLabel={`Send invite to ${pasted.issuer.displayName}`}
            note="Checking this link sends no request. They still choose whether to accept."
            disabled={!pasted.canSend}
            onSend={pasted.onSend}
          />
        ) : null}
      </View>
      <View style={styles.promise}>
        <Icon name="lock" size={18} />
        <Text variant="bodyS" style={styles.promiseText}>
          We never upload your contacts. People find you only by your handle or a link you share.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { gap: spacing[4] },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
  found: {
    gap: spacing[2],
    padding: spacing[3],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.panel,
    backgroundColor: content.paper,
  },
  foundTop: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
  foundText: { flex: 1, minWidth: 0, gap: spacing[0.5] },
  or: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
  rule: { flex: 1, height: borderWidth.hairline, backgroundColor: content.rule },
  paste: { gap: spacing[3] },
  promise: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing[2],
    padding: spacing[3],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.panel,
  },
  promiseText: { flex: 1 },
});
