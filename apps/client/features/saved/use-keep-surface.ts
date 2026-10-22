import { useCallback, useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';
import type { AccountScope } from '@knowscroll/client-core';
import type { KeepAssetRef, KeepPosition } from '@knowscroll/contracts';
import { newCommandId } from '../../platform/command-id';
import { createKeepSurface } from './keep-surface';

/** Focus/background cleanup captures while the actual renderer/SDK ref is still mounted. */
export function useKeepSurface(
  scope: AccountScope,
  target: KeepAssetRef,
  exposureId: string,
  capture: () => KeepPosition | undefined,
) {
  const surface = useMemo(
    () => createKeepSurface({ scope, target, exposureId, capture, newId: newCommandId }),
    [scope, target, exposureId, capture],
  );
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  useFocusEffect(
    useCallback(() => {
      setForeground(AppState.currentState === 'active');
      const listener = AppState.addEventListener('change', (value) => {
        if (value !== 'active') surface.checkpoint();
        setForeground(value === 'active');
      });
      return () => {
        surface.stop();
        setForeground(false);
        listener.remove();
      };
    }, [surface]),
  );
  useLayoutEffect(() => {
    if (!foreground) return;
    surface.start();
    return () => surface.stop();
  }, [surface, foreground]);
  return { surface, state: useSyncExternalStore(surface.subscribe, surface.getState, surface.getState) };
}
