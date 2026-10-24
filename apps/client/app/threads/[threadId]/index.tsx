import { useLocalSearchParams } from 'expo-router';
import { ThreadScreen } from '../../../features/threads/thread-screen';

/** `/threads/<id>?m=<membership>&r=<revision>`: a content thread, opened with the person's own reference. */
export default function Thread() {
  const { threadId, m, r } = useLocalSearchParams<{ threadId: string; m?: string; r?: string }>();
  return <ThreadScreen threadId={threadId} m={m} r={r} />;
}
