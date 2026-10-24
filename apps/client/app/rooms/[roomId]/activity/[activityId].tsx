import { useLocalSearchParams } from 'expo-router';
import { ActivityScreen } from '../../../../features/rooms/activity-screen';

/** `/rooms/<id>/activity/<activityId>`: one poll or quiz of a room (R03). Optional, unscored, kept in the room. */
export default function RoomActivity() {
  const { roomId, activityId } = useLocalSearchParams<{ roomId: string; activityId: string }>();
  return <ActivityScreen roomId={roomId} activityId={activityId} />;
}
