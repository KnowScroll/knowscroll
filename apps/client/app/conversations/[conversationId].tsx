import { useLocalSearchParams } from 'expo-router';
import { ConversationScreen } from '../../features/conversations/conversation-screen';

export default function Conversation() {
  const { conversationId } = useLocalSearchParams<{ conversationId?: string | string[] }>();
  return <ConversationScreen conversationId={typeof conversationId === 'string' ? conversationId : undefined} />;
}
