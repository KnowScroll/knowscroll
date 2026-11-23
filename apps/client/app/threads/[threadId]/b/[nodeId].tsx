import { useLocalSearchParams } from 'expo-router';
import { BranchScreen } from '../../../../features/scenarios/branch-screen';
import { NotFoundScreen } from '../../../../features/not-found/not-found-screen';
import { useMadeToOrderState } from '../../../../providers/made-to-order';

/**
 * `/threads/<id>/b/<node>`: one branch of the thread (X03), with its own item and a way back to the original. A branch is
 * made to order, so while the API says those are off (D-436) an address to one is an address that is not a screen: the app's
 * own not-found page, never a half-drawn branch. While the answer has not arrived nothing is drawn, so a branch never shows
 * for a moment and then goes.
 */
export default function ThreadBranch() {
  const { threadId, nodeId, m, r } = useLocalSearchParams<{
    threadId: string;
    nodeId: string;
    m?: string;
    r?: string;
  }>();
  const madeToOrder = useMadeToOrderState();
  if (madeToOrder === 'unknown') return null;
  if (madeToOrder === 'off') return <NotFoundScreen />;
  return <BranchScreen threadId={threadId} nodeId={nodeId} m={m} r={r} />;
}
