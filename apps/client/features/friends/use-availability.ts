import { useCallback, useEffect, useSyncExternalStore } from 'react';
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

function useAvailabilitySession(scope: AccountScope): AvailabilitySession | undefined {
  return useMountedResource<AvailabilitySession>(scope, 'availability', (own) => {
    const made = createAvailabilitySession({ scope: own, newId: newCommandId });
    return { value: made, dispose: made.dispose };
  });
}

/** The word for a friend now. The words stop at their lease: the session notifies when one does, and the screen asks again. */
function useWordOf(session: AvailabilitySession | undefined): (personId: string) => AvailabilityWord | undefined {
  const subscribe = useCallback((listener: () => void) => session?.subscribe(listener) ?? (() => {}), [session]);
  useSyncExternalStore(
    subscribe,
    () => session?.getState(),
    () => session?.getState(),
  );
  return (personId) => session?.wordOf(personId);
}

/**
 * Which friends are shown as "Online" or "Recently active" right now, rereading while the screen is
 * showing and the app is open. A friend not in the list is shown with no word at all, because hidden,
 * expired and unknown are one answer.
 */
export function useAvailability(scope: AccountScope): (personId: string) => AvailabilityWord | undefined {
  const session = useAvailabilitySession(scope);
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
  return useWordOf(session);
}

/**
 * The same words for a picker that opens over another screen (the share sheet): read while `open`
 * is true, and not at all once it is false or the sheet closes.
 */
export function useSheetAvailability(
  scope: AccountScope,
  open: boolean,
): (personId: string) => AvailabilityWord | undefined {
  const session = useAvailabilitySession(scope);
  useEffect(() => {
    if (!open) return undefined;
    session?.setForeground(true);
    return () => session?.setForeground(false);
  }, [session, open]);
  return useWordOf(session);
}

/** How a friend's availability is written, or nothing. */
export function availabilityLabel(word: AvailabilityWord | undefined): string | undefined {
  return word === undefined ? undefined : word === 'online' ? 'Online' : 'Recently active';
}
