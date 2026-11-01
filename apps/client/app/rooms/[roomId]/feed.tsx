import { useLocalSearchParams } from 'expo-router';
import { RoomFeedScreen } from '../../../features/rooms/feed-screen';

/** `/rooms/<id>/feed`: what the room's residents found in the library, and what they remember (v3 R-8). */
export default function RoomFeed() {
  const { roomId } = useLocalSearchParams<{ roomId: string }>();
  return <RoomFeedScreen roomId={roomId} />;
}
