import { useLocalSearchParams } from 'expo-router';
import { ActivitiesScreen } from '../../../../features/rooms/activities-screen';

/** `/rooms/<id>/activity`: the room's polls and quizzes (R03). Reached only from inside the room. */
export default function RoomActivities() {
  const { roomId } = useLocalSearchParams<{ roomId: string }>();
  return <ActivitiesScreen roomId={roomId} />;
}
