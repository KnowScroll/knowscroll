import { useCallback } from 'react';
import { BackHandler } from 'react-native';
import { useFocusEffect } from 'expo-router';
import type { EncounterSession } from './encounter-session';

export function useEncounterBack(session: EncounterSession, enabled: boolean) {
  useFocusEffect(
    useCallback(() => {
      if (!enabled) return;
      const subscription = BackHandler.addEventListener('hardwareBackPress', () => session.back());
      return () => subscription.remove();
    }, [session, enabled]),
  );
  return () => session.back();
}
