import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { AccountScope } from '@knowscroll/client-core';
import type { ConversationContentRef, DirectConversationRef } from '@knowscroll/contracts';
import { spacing } from '@knowscroll/design-tokens';
import { SendToFriend } from './send-to-friend';
import { ShareMenu } from './share-menu';
import { useShareSession } from './use-share-session';

export interface ShareSheetContentProps {
  readonly scope: AccountScope;
  /** The exact revision being shared. */
  readonly target: ConversationContentRef;
  /** The title of what is shared, for the system share text. The container's header names the sheet. */
  readonly title: string;
  /** The origin links are built on: the app's own origin, where `/s/*` reaches the API. */
  readonly origin: string;
  /** Closes the sheet (Cancel). The caller restores what was playing; overlays never enter Back history. */
  readonly onClose: () => void;
  /** After "Sent": open the conversation. */
  readonly onOpenConversation: (conversation: DirectConversationRef) => void;
  /**
   * "Explore with friends" (a content thread with chosen friends). Offered only when the caller
   * passes it, so the option appears with the slice that makes it work and never before.
   */
  readonly onExploreWithFriends?: () => void;
}

/**
 * H01: the content of the share sheet, the same for a Reel and a Scroll. The menu offers "Send to a
 * conversation" (`SendToFriend`) and "Copy link", a public link that shows only the title and
 * summary and can be stopped. "Sent" is shown only after the server's receipt, and copying a link
 * or opening the system share sheet never claims anyone received anything. Choosing, sending and
 * copying are not encounters and create no evidence.
 *
 * The caller owns the container and its header (title "Share", the shared item's name): it pauses
 * playback while this is open, restores it on close, and keeps the sheet out of the Back history
 * (D-006 k).
 */
export function ShareSheetContent(props: ShareSheetContentProps) {
  const { scope, title, onClose, onOpenConversation, onExploreWithFriends } = props;
  const { session, state } = useShareSession(scope, props.target, props.origin);
  const [view, setView] = useState<'menu' | 'send'>('menu');
  return (
    <View style={styles.sheet}>
      {view === 'menu' ? (
        <ShareMenu
          session={session}
          link={state.link}
          title={title}
          onSendToConversation={() => setView('send')}
          onExploreWithFriends={onExploreWithFriends}
          onClose={onClose}
        />
      ) : (
        <SendToFriend
          session={session}
          state={state}
          onBack={() => setView('menu')}
          onClose={onClose}
          onOpenConversation={onOpenConversation}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({ sheet: { gap: spacing[3] } });
