import { useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import {
  createExploreWithFriends,
  type AccountScope,
  type ExploreWithFriendsSession,
  type ExploreWithFriendsState,
} from '@knowscroll/client-core';
import { MAX_THREAD_FRIENDS, type ContentThreadRef, type ConversationContentRef } from '@knowscroll/contracts';
import { borderWidth, content, radius, spacing, target as targetSize } from '@knowscroll/design-tokens';
import { Banner, Button, Icon, Text, useFocusRing, useTypeStyle } from '@knowscroll/ui';
import { newCommandId } from '../../platform/command-id';
import { PersonAvatar } from '../conversations/person-avatar';

/** More friends than this and a search box appears above the list. */
const SEARCH_FROM = 5;

function Row({
  person,
  selected,
  disabled,
  onToggle,
}: {
  readonly person: ExploreWithFriendsState['friends']['items'][number];
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly onToggle: () => void;
}) {
  const focus = useFocusRing('onLight');
  return (
    <Pressable
      {...focus.props}
      role="checkbox"
      aria-checked={selected}
      accessibilityLabel={person.displayName}
      disabled={disabled}
      onPress={onToggle}
      style={[styles.row, focus.style]}
    >
      <PersonAvatar person={person} size={40} />
      <View style={styles.rowText}>
        <Text variant="ui" numberOfLines={1}>
          {person.displayName}
        </Text>
        <Text variant="meta" color={content.ink2} numberOfLines={1}>
          @{person.handle}
        </Text>
      </View>
      <View style={[styles.box, selected ? styles.boxOn : null]}>
        {selected ? <Icon name="check" size={14} color={content.onAccent} /> : null}
      </View>
    </Pressable>
  );
}

function useSession(scope: AccountScope, root: ConversationContentRef) {
  const [session] = useState<ExploreWithFriendsSession>(() => createExploreWithFriends({ scope, root, newId: newCommandId }));
  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState);
  return { session, state };
}

/**
 * H01 "Explore with friends": choose people, optionally name the thread, and create it. Friends are
 * invited, never added: they join when they answer. "Created" is shown only after the server's
 * receipt, and an unknown outcome keeps the same command for the retry. Choosing people tells nobody
 * anything and records nothing about anyone.
 */
export function ExploreWithFriends({
  scope,
  root,
  onBack,
  onClose,
  onOpenThread,
}: {
  readonly scope: AccountScope;
  /** The exact revision the thread starts from. */
  readonly root: ConversationContentRef;
  readonly onBack: () => void;
  readonly onClose: () => void;
  readonly onOpenThread: (thread: ContentThreadRef) => void;
}) {
  const { session, state } = useSession(scope, root);
  const [query, setQuery] = useState('');
  const type = useTypeStyle('bodyS');
  useEffect(() => {
    void session.loadFriends();
  }, [session]);
  const { friends, selected, create } = state;
  const needle = query.trim().toLowerCase();
  const visible = friends.items.filter((person) => `${person.displayName} ${person.handle}`.toLowerCase().includes(needle));
  const locked = create.status === 'creating' || create.status === 'unconfirmed' || create.status === 'created';
  const count = selected.length;
  if (create.status === 'created')
    return (
      <View style={styles.section}>
        <View style={styles.receipt} accessibilityLiveRegion="polite">
          <Text variant="bodyS">Thread created</Text>
          <Button label="Open thread" size="sm" onPress={() => onOpenThread(create.thread)} testID="open-thread" />
        </View>
        <Button label="Done" fullWidth variant="ghost" onPress={onClose} />
      </View>
    );
  return (
    <View style={styles.section}>
      <View style={styles.back}>
        <Button label="Back" size="sm" variant="ghost" icon="back" onPress={onBack} disabled={locked} />
        <Text variant="title" heading={2}>
          Explore with friends
        </Text>
      </View>
      <Text variant="meta" color={content.ink2}>
        Friends can open it whenever they like. Everyone keeps their own place.
      </Text>
      <View style={styles.field}>
        <Text variant="uiS">Thread name (optional)</Text>
        <TextInput
          accessibilityLabel="Thread name (optional)"
          value={state.name}
          onChangeText={session.setName}
          editable={!locked}
          maxLength={80}
          allowFontScaling={false}
          style={[styles.input, { fontFamily: type.fontFamily, fontSize: type.fontSize, lineHeight: type.lineHeight }]}
        />
      </View>
      {friends.status === 'loading' && friends.items.length === 0 ? (
        <Text variant="meta" color={content.ink2}>
          Loading your friends…
        </Text>
      ) : null}
      {friends.status === 'failed' ? (
        <Banner kind="error" lead="Couldn’t load your friends." message="Check your connection and try again." />
      ) : null}
      {friends.status === 'ready' && friends.items.length === 0 ? (
        <Text variant="bodyS">You haven’t got any friends here yet. Invite a friend from Talk, then share this with them.</Text>
      ) : null}
      {friends.items.length > SEARCH_FROM ? (
        <TextInput
          accessibilityLabel="Search friends"
          placeholder="Search friends"
          placeholderTextColor={content.ink2}
          value={query}
          onChangeText={setQuery}
          allowFontScaling={false}
          style={[styles.input, { fontFamily: type.fontFamily, fontSize: type.fontSize, lineHeight: type.lineHeight }]}
        />
      ) : null}
      <View role="group" accessibilityLabel="Friends to invite" style={styles.rows}>
        {visible.map((person) => (
          <Row
            key={person.personId}
            person={person}
            selected={selected.includes(person.personId)}
            disabled={locked || (!selected.includes(person.personId) && selected.length >= MAX_THREAD_FRIENDS)}
            onToggle={() => session.toggle(person.personId)}
          />
        ))}
      </View>
      {create.status === 'unconfirmed' ? (
        <Banner
          kind="error"
          lead="Couldn’t confirm it was created."
          message="Retrying makes the same thread, so there can’t be two."
        />
      ) : null}
      {create.status === 'unavailable' ? (
        <Banner kind="error" lead="This can’t be started right now." message="Choose different people or try again later." />
      ) : null}
      {create.status === 'failed' ? (
        <Banner kind="error" lead="Couldn’t create the thread." message="Nothing was created. Try again." />
      ) : null}
      <Button
        label={
          create.status === 'unconfirmed'
            ? 'Retry'
            : count === 0
              ? 'Choose friends'
              : `Create thread · ${String(count)} ${count === 1 ? 'friend' : 'friends'}`
        }
        variant="primary"
        fullWidth
        busy={create.status === 'creating'}
        busyLabel="Creating"
        disabled={count === 0}
        onPress={() => void session.create()}
        testID="create-thread"
      />
      <Button label="Cancel" fullWidth variant="ghost" onPress={onClose} />
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: spacing[3] },
  back: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
  field: { gap: spacing[1] },
  rows: { gap: spacing[1] },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    minHeight: targetSize.comfortable,
    paddingVertical: spacing[2],
    borderBottomWidth: borderWidth.hairline,
    borderBottomColor: content.rule,
  },
  rowText: { flex: 1, gap: spacing[0.5] },
  box: {
    width: 24,
    height: 24,
    borderRadius: radius.xs,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxOn: { backgroundColor: content.accent },
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
