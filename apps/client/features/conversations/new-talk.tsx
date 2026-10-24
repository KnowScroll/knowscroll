import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { AccountScope } from '@knowscroll/client-core';
import { content, spacing } from '@knowscroll/design-tokens';
import { BottomSheet, Button, IconButton, Text } from '@knowscroll/ui';
import { useRoomList } from '../rooms/use-room';
import { useThreadInbox } from '../threads/use-thread-inbox';
import { useTalkInbox } from './use-talk-inbox';

/** Whether Talk has anything to list: a conversation, a thread (or invitation) or a room. */
export function useTalkHasContent(scope: AccountScope | undefined): boolean {
  const inbox = useTalkInbox(scope);
  const threads = useThreadInbox(scope);
  const rooms = useRoomList(scope);
  return inbox.items.length + threads.items.length + rooms.items.length > 0;
}

/**
 * C01's New button, in Talk's header once there is something in the list (the first-visit screen
 * carries the same two choices as its own buttons). A conversation starts when something is shared with a friend, so New leads to
 * the two places that begin one: Explore (share a Reel or Scroll) and Friends (add the person).
 */
export function NewTalkButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const go = (path: '/explore' | '/friends') => {
    setOpen(false);
    router.push(path);
  };
  return (
    <>
      <IconButton icon="plus" label="New conversation" onPress={() => setOpen(true)} testID="talk-new" />
      <BottomSheet visible={open} title="Start a conversation" onClose={() => setOpen(false)}>
        <View style={styles.body}>
          <Text variant="bodyS" color={content.ink2}>
            A conversation starts when you share a Reel or a Scroll with a friend.
          </Text>
          <Button label="Share something" variant="primary" fullWidth onPress={() => go('/explore')} />
          <Button label="Invite a friend" fullWidth onPress={() => go('/friends')} />
        </View>
      </BottomSheet>
    </>
  );
}

const styles = StyleSheet.create({ body: { gap: spacing[3], paddingBottom: spacing[2] } });
