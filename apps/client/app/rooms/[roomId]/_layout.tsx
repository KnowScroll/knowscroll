import { Stack, useLocalSearchParams } from 'expo-router';
import { useDisplay } from '@knowscroll/ui';
import { RoomWorkspace } from '../../../features/rooms/room-workspace';

/**
 * A room's screens: on a phone or tablet each is a page of its own; from 1024 px (D04) a member sees the
 * room, the open discussion and the room's optional extras side by side, and the screens below render in
 * the centre.
 */
export default function RoomLayout() {
  const { roomId } = useLocalSearchParams<{ roomId: string }>();
  const { breakpoint } = useDisplay();
  const stack = <Stack screenOptions={{ headerShown: false }} />;
  return breakpoint === 'desktop' ? <RoomWorkspace roomId={roomId}>{stack}</RoomWorkspace> : stack;
}
