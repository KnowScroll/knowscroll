import { useLocalSearchParams } from 'expo-router';
import { RoomScreen } from '../../../features/rooms/room-screen';

/** `/rooms/<id>/feed`: the room opened on its Feed tab, what its residents found in the library and what they remember (v3 R-8c). */
export default function RoomFeed() {
  const { roomId } = useLocalSearchParams<{ roomId: string }>();
  return <RoomScreen roomId={roomId} initialTab="feed" />;
}
