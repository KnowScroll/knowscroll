import { useLocalSearchParams } from 'expo-router';
import { ConversationScreen } from '../../features/conversations/conversation-screen';

/** `/conversations/<id>?m=<membership>&r=<revision>`: a conversation, opened with the person's own reference. */
export default function Conversation() {
  const { conversationId, m, r } = useLocalSearchParams<{ conversationId: string; m?: string; r?: string }>();
  return <ConversationScreen conversationId={conversationId} m={m} r={r} />;
}
