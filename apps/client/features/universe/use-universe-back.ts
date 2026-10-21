import { useCallback } from 'react';
import { BackHandler } from 'react-native';
import { useFocusEffect } from 'expo-router';
import type { UniverseViewSession } from './universe-session';
export function useUniverseBack(session: UniverseViewSession, enabled: boolean) {
  useFocusEffect(
    useCallback(() => {
      if (!enabled) return;
      const subscription = BackHandler.addEventListener('hardwareBackPress', session.back);
      return () => subscription.remove();
    }, [session, enabled]),
  );
  return session.back;
}
