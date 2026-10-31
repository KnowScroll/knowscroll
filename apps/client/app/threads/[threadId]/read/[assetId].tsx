import { useLocalSearchParams } from 'expo-router';
import { ThreadScrollReaderScreen } from '../../../../features/threads/thread-scroll-reader';

/** `/threads/<id>/read/<assetId>`: one Scroll of the thread, read in full, with sharing back into the thread. */
export default function ThreadRead() {
  const { threadId, assetId, m, r, p } = useLocalSearchParams<{
    threadId: string;
    assetId: string;
    m?: string;
    r?: string;
    p?: string;
  }>();
  return <ThreadScrollReaderScreen threadId={threadId} assetId={assetId} m={m} r={r} p={p} />;
}
