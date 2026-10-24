import { useRouter } from 'expo-router';
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { content } from '@knowscroll/design-tokens';
import { useDisplay, type Destination } from '@knowscroll/ui';
import { useAccountScope } from '../../providers/account-scope';
import { useTalkInbox } from '../conversations/use-talk-inbox';
import { destinationHref, PrimaryRail, railWidth, usesRail } from './app-navigation';

/** The rail with Talk current. It reads the inbox only for the unread dot, so phones (no rail) never mount it. */
function TalkRail() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { state } = useAccountScope();
  const unread = useTalkInbox(state.status === 'signed_in' ? state.scope : undefined).unread;
  return (
    <PrimaryRail
      active="conversations"
      accountCurrent={false}
      tone="paper"
      insets={insets}
      unread={unread}
      onSelect={(destination: Destination) => router.navigate(destinationHref(destination))}
    />
  );
}

/**
 * The frame of a Talk screen that is not a tab (a conversation, a content thread): the page's one
 * `main`, and on tablets and desktops the navigation rail with Talk current (D03), drawn after the
 * content in the document like the tabs' rail (V01: content, then navigation). Phones have no
 * bar here: the screen has its own Back.
 */
export function TalkFrame({ children }: { readonly children: ReactNode }) {
  const insets = useSafeAreaInsets();
  const { breakpoint } = useDisplay();
  const railed = usesRail(breakpoint);
  return (
    <View style={styles.frame}>
      <View role="main" style={[styles.main, railed ? { marginLeft: railWidth(breakpoint) + insets.left } : null]}>
        {children}
      </View>
      {railed ? <TalkRail /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { flex: 1, backgroundColor: content.paper },
  main: { flex: 1, minHeight: 0 },
});
