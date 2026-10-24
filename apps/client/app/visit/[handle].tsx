import { useLocalSearchParams } from 'expo-router';
import { VisitScreen } from '../../features/visit/visit-screen';

/** `/visit/<handle>` (U06): a friend's universe. The handle is public; the server decides what is shown. */
export default function Visit() {
  const { handle } = useLocalSearchParams<{ handle: string }>();
  return <VisitScreen handle={typeof handle === 'string' ? handle : ''} />;
}
