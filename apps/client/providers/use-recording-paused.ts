import { useSyncExternalStore } from 'react';
import { useAccountScope } from './account-scope';

const noSubscription = () => () => undefined;
const noPolicy = () => undefined;

/**
 * Whether the signed-in person has paused recording (D-083), for a screen that is inside the account provider. False while signed out or before the policy has been read:
 * a screen that needs the answer for a rule still asks the server, and this only lets it say so early.
 */
export function useRecordingPaused(): boolean {
  const { state } = useAccountScope();
  const recording = state.status === 'signed_in' ? state.scope.recording : undefined;
  const policy = useSyncExternalStore(
    recording?.subscribe ?? noSubscription,
    recording?.getState ?? noPolicy,
    recording?.getState ?? noPolicy,
  );
  return policy?.policy !== undefined && !policy.policy.on;
}
