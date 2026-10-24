import { useLocalSearchParams } from 'expo-router';
import { RoomScreen } from '../../../features/rooms/room-screen';

/** `/rooms/<id>`: a room, as a preview before joining (R01) and as its discussions after (R02). */
export default function Room() {
  const { roomId } = useLocalSearchParams<{ roomId: string }>();
  return <RoomScreen roomId={roomId} />;
}
