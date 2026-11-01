import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { AppState } from 'react-native';
import { readRoomStations, type AccountScope } from '@knowscroll/client-core';
import type { RoomStation } from '@knowscroll/contracts';
import { newCommandId } from '../../platform/command-id';

/** How often the map asks again while it is on screen: a Launch lasts about two minutes and its station says "Launch live" meanwhile. */
export const STATION_REFRESH_MS = 20_000;

/**
 * The room stations of the person's own map. They are optional decoration beside real places: a read
 * that fails leaves the map as it was, and nothing is drawn for a room the person's map does not hold.
 * They are read each time the Universe regains focus, since they follow the map, and again every
 * `STATION_REFRESH_MS` while it stays on screen, so a Launch that starts or ends in one of the person's rooms shows
 * on its station without leaving the map (R-6, D-224). The state changes only when the answer does. Kept free of the
 * query cache on purpose: the Universe has no other reason to need one.
 */
export function useRoomStationsOnMap(scope: AccountScope): readonly RoomStation[] {
  const [stations, setStations] = useState<readonly RoomStation[]>([]);
  useFocusEffect(
    useCallback(() => {
      let current = true;
      const read = () => {
        void readRoomStations(scope, newCommandId).then(
          (found) => {
            if (current) setStations((was) => (JSON.stringify(was) === JSON.stringify(found) ? was : found));
          },
          () => undefined,
        );
      };
      read();
      const timer = setInterval(() => {
        if (AppState.currentState !== 'background' && AppState.currentState !== 'inactive') read();
      }, STATION_REFRESH_MS);
      return () => {
        current = false;
        clearInterval(timer);
      };
    }, [scope]),
  );
  return stations;
}
