import { useCallback, useSyncExternalStore } from 'react';
import { useFocusEffect } from 'expo-router';
import { AppState } from 'react-native';
import {
  createAvailabilitySession,
  type AccountScope,
  type AvailabilitySession,
  type AvailabilityWord,
} from '@knowscroll/client-core';
import { newCommandId } from '../../platform/command-id';
import { useMountedResource } from '../../platform/use-mounted-resource';

/**
 * Which friends are shown as "Online" or "Recently active" right now, rereading while the screen is
 * showing and the app is open. A friend not in the list is shown with no word at all, because hidden,
 * expired and unknown are one answer.
 */
export function useAvailability(scope: AccountScope): (personId: string) => AvailabilityWord | undefined {
  const session = useMountedResource<AvailabilitySession>(scope, 'availability', (own) => {
    const made = createAvailabilitySession({ scope: own, newId: newCommandId });
    return { value: made, dispose: made.dispose };
  });
  useFocusEffect(
    useCallback(() => {
      if (!session) return undefined;
      const active = (value: boolean) => session.setForeground(value);
      active(AppState.currentState === 'active');
      const listener = AppState.addEventListener('change', (value) => active(value === 'active'));
      return () => {
        active(false);
        listener.remove();
      };
    }, [session]),
  );
  const subscribe = useCallback((listener: () => void) => session?.subscribe(listener) ?? (() => {}), [session]);
  // The words stop at their lease; the session notifies when one does, and the screen asks again.
  useSyncExternalStore(
    subscribe,
    () => session?.getState(),
    () => session?.getState(),
  );
  return (personId) => session?.wordOf(personId);
}
