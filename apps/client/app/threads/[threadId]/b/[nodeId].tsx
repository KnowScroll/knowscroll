import { useLocalSearchParams } from 'expo-router';
import { BranchScreen } from '../../../../features/scenarios/branch-screen';

/** `/threads/<id>/b/<node>`: one branch of the thread (X03), with its own item and a way back to the original. */
export default function ThreadBranch() {
  const { threadId, nodeId, m, r } = useLocalSearchParams<{
    threadId: string;
    nodeId: string;
    m?: string;
    r?: string;
  }>();
  return <BranchScreen threadId={threadId} nodeId={nodeId} m={m} r={r} />;
}
