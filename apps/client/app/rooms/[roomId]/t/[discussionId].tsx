import { useLocalSearchParams } from 'expo-router';
import { RoomDiscussionScreen } from '../../../../features/rooms/discussion-screen';

/** `/rooms/<id>/t/<discussionId>`: one discussion of a room, the same thread as a friend's (R02). */
export default function RoomDiscussion() {
  const { roomId, discussionId } = useLocalSearchParams<{ roomId: string; discussionId: string }>();
  return <RoomDiscussionScreen roomId={roomId} discussionId={discussionId} />;
}
