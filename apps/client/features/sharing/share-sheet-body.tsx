import { useRouter } from 'expo-router';
import type { ConversationContentRef } from '@knowscroll/contracts';
import { Text } from '@knowscroll/ui';
import { afterPendingBack } from '../../platform/after-pending-back';
import { appApiOrigin } from '../../platform/api';
import { useAccountScope } from '../../providers/account-scope';
import { conversationHref } from '../conversations/conversation-links';
import { threadHref } from '../threads/thread-links';
import { ShareSheetContent } from './share-sheet-content';

export interface ShareSheetBodyProps {
  /** The exact asset revision on screen. */
  readonly target: ConversationContentRef;
  /** The title of what is shared. */
  readonly title: string;
  /** Whether it is a Reel or a Scroll. */
  readonly kind: 'reel' | 'scroll';
  /** Closes the sheet, restoring playback. Called before the app leaves for a conversation. */
  readonly onClose: () => void;
}

/**
 * H01, ready to sit inside a sheet: Send to a conversation, Explore with friends, Copy link, Share elsewhere. The container
 * owns the sheet's header and its place on the encounter: it pauses playback while the sheet is open,
 * restores it in `onClose` and keeps the sheet out of Back history (D-006 k). Opening a conversation or a thread
 * closes the sheet first, then navigates once the browser has finished that Back.
 */
export function ShareSheetBody({ target, title, kind, onClose }: ShareSheetBodyProps) {
  const router = useRouter();
  const { state } = useAccountScope();
  const origin = appApiOrigin();
  if (state.status !== 'signed_in') return <Text variant="bodyS">Sign in to share this.</Text>;
  if (!origin.ok) return <Text variant="bodyS">Sharing isn’t available right now.</Text>;
  return (
    <ShareSheetContent
      scope={state.scope}
      target={target}
      title={title}
      kind={kind}
      origin={origin.baseUrl}
      onClose={onClose}
      onOpenConversation={(conversation) => {
        onClose();
        afterPendingBack(() => router.navigate(conversationHref(conversation)));
      }}
      onOpenThread={(thread) => {
        onClose();
        afterPendingBack(() => router.navigate(threadHref(thread)));
      }}
    />
  );
}
