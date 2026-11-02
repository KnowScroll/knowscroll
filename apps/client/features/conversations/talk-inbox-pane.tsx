import { ScrollView, StyleSheet, View } from 'react-native';
import type { AccountScope } from '@knowscroll/client-core';
import { borderWidth, content, layout, spacing, universe } from '@knowscroll/design-tokens';
import { Text } from '@knowscroll/ui';
import { PANE_LIST_WIDTH, TalkList } from './conversations-screen';
import { useTalkListLook } from './talk-list-look';

/**
 * Talk's list as the first column beside an open conversation or thread (D03, T3): the title and the grouped list
 * with the open one marked. From 1024 px a conversation and a thread both keep it, so moving between them never
 * loses the list.
 */
export function TalkInboxPane({ scope, currentId }: { readonly scope: AccountScope; readonly currentId: string }) {
  const look = useTalkListLook();
  return (
    <View
      role="complementary"
      aria-label="Conversations"
      style={[styles.inbox, { backgroundColor: look.dark ? universe.sky : content.paper }]}
    >
      <ScrollView contentContainerStyle={styles.content}>
        <Text variant="title" heading={2} color={look.text}>
          Talk
        </Text>
        <TalkList scope={scope} currentId={currentId} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  inbox: {
    width: PANE_LIST_WIDTH + 2 * layout.gutter,
    borderRightWidth: borderWidth.regular,
    borderRightColor: content.ink,
  },
  content: { padding: layout.gutter, gap: spacing[3] },
});
