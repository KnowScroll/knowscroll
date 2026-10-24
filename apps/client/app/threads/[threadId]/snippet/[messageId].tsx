import { useLocalSearchParams } from 'expo-router';
import { SnippetViewerScreen } from '../../../../features/threads/snippet-viewer';

/** `/threads/<id>/snippet/<messageId>`: a focused viewer over the thread (H03); Back returns to the same message. */
export default function ThreadSnippet() {
  const { threadId, messageId, m, r } = useLocalSearchParams<{
    threadId: string;
    messageId: string;
    m?: string;
    r?: string;
  }>();
  return <SnippetViewerScreen threadId={threadId} messageId={messageId} m={m} r={r} />;
}
