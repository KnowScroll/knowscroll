import { useLocalSearchParams } from 'expo-router';
import { RoomTodayScreen } from '../../../features/rooms/today-screen';

/** `/rooms/<id>/today`: the room's daily channel (R3 B): today's question, Spot the flaw and the day's talk. */
export default function RoomToday() {
  const { roomId } = useLocalSearchParams<{ roomId: string }>();
  return <RoomTodayScreen roomId={roomId} />;
}
