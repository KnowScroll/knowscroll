import { useRouter } from 'expo-router';
import { useState, useSyncExternalStore } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { createExploreWithFriends, type AccountScope, type ExploreWithFriendsSession } from '@knowscroll/client-core';
import type {
  ConversationContentProjection,
  ConversationContentRef,
  EncounterMetadata,
  PublicPersonRef,
} from '@knowscroll/contracts';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { Banner, BottomSheet, Button, Text, useTypeStyle } from '@knowscroll/ui';
import { newCommandId } from '../../platform/command-id';
import { threadHref } from '../threads/thread-links';

/** What a conversation can turn into a thread: the exact revision of a card shared in it. */
export interface ThreadRoot {
  readonly target: ConversationContentRef;
  readonly metadata: EncounterMetadata;
}

/** The thread a shared card can start: its exact revision (the current one for a corrected card), or nothing for a withdrawn card. */
export function rootOfCard(card: ConversationContentProjection): ThreadRoot | undefined {
  if (card.status === 'available') return { target: card.target, metadata: card.metadata };
  if (card.status === 'corrected')
    return {
      target: { assetId: card.current.assetId, assetRevision: card.current.assetRevision },
      metadata: card.current.metadata,
    };
  return undefined;
}

function useStartSession(scope: AccountScope, root: ConversationContentRef, peer: PublicPersonRef) {
  const [session] = useState<ExploreWithFriendsSession>(() => {
    const created = createExploreWithFriends({ scope, root, newId: newCommandId });
    created.toggle(peer.personId);
    return created;
  });
  return { session, state: useSyncExternalStore(session.subscribe, session.getState, session.getState) };
}

function StartThreadForm({
  scope,
  root,
  peer,
  watch,
  onClose,
}: {
  readonly scope: AccountScope;
  readonly root: ThreadRoot;
  readonly peer: PublicPersonRef;
  readonly watch: boolean;
  readonly onClose: () => void;
}) {
  const router = useRouter();
  const type = useTypeStyle('bodyS');
  const { session, state } = useStartSession(scope, root.target, peer);
  const { create } = state;
  const word = root.metadata.kind === 'reel' ? 'Reel' : 'Scroll';
  const locked = create.status === 'creating' || create.status === 'unconfirmed' || create.status === 'created';
  if (create.status === 'created') {
    const thread = create.thread;
    return (
      <View style={styles.body}>
        <View style={styles.receipt} accessibilityLiveRegion="polite">
          <Text variant="bodyS">Thread started</Text>
          <Button
            label="Open thread"
            size="sm"
            onPress={() => {
              onClose();
              router.push(threadHref(thread));
            }}
            testID="open-started-thread"
          />
        </View>
        <Button label="Done" variant="ghost" fullWidth onPress={onClose} />
      </View>
    );
  }
  return (
    <View style={styles.body}>
      <Text variant="bodyS" color={content.ink2}>
        {peer.displayName} is invited and joins when they answer. {watch ? 'This chat stays as it is. ' : ''}Everyone
        keeps their own place in the {word}; nothing plays together.
      </Text>
      <View style={styles.about}>
        <Text variant="label" color={content.ink2}>
          {word}
        </Text>
        <Text variant="ui" numberOfLines={2}>
          {root.metadata.title}
        </Text>
      </View>
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
      {create.status === 'unconfirmed' ? (
        <Banner
          kind="error"
          lead="Couldn’t confirm it was started."
          message="Retrying makes the same thread, so there can’t be two."
        />
      ) : null}
      {create.status === 'unavailable' ? (
        <Banner kind="error" lead="This can’t be started right now." message="Try again later." />
      ) : null}
      {create.status === 'failed' ? (
        <Banner kind="error" lead="Couldn’t start the thread." message="Nothing was created. Try again." />
      ) : null}
      <Button
        label={create.status === 'unconfirmed' ? 'Retry' : watch ? 'Watch together' : 'Start thread'}
        variant="primary"
        fullWidth
        busy={create.status === 'creating'}
        busyLabel="Starting"
        onPress={() => void session.create()}
        testID="start-thread"
      />
      <Button label="Cancel" variant="ghost" fullWidth onPress={onClose} />
    </View>
  );
}

/**
 * C02's Start a thread: the Reel or Scroll shared in this conversation becomes a content thread with
 * the person on the other side (more people can be added from the share sheet's Explore with friends).
 * It sends one create command whose ID is kept for a retry, and says "started" only after the receipt.
 * "Watch together" (T3 Q5) is the same thread, started from the card itself: the chat stays a chat, the
 * thread is made for the same two people, and nobody's playback is shared or followed.
 */
export function StartThreadSheet({
  visible,
  scope,
  root,
  peer,
  purpose = 'start',
  onClose,
}: {
  readonly visible: boolean;
  readonly scope: AccountScope;
  readonly root: ThreadRoot;
  readonly peer: PublicPersonRef;
  readonly purpose?: 'start' | 'watch';
  readonly onClose: () => void;
}) {
  const watch = purpose === 'watch';
  return (
    <BottomSheet visible={visible} title={watch ? 'Watch together' : 'Start a thread'} onClose={onClose}>
      {visible ? <StartThreadForm scope={scope} root={root} peer={peer} watch={watch} onClose={onClose} /> : null}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  body: { gap: spacing[3], paddingBottom: spacing[2] },
  about: {
    gap: spacing[1],
    padding: spacing[3],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.md,
  },
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
