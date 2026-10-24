import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { readRoomStations, type AccountScope } from '@knowscroll/client-core';
import type { RoomStation } from '@knowscroll/contracts';
import { newCommandId } from '../../platform/command-id';

/**
 * The room stations of the person's own map. They are optional decoration beside real places: a read
 * that fails leaves the map as it was, and nothing is drawn for a room the person's map does not hold.
 * They are read each time the Universe regains focus, since they follow the map. Kept free of the query
 * cache on purpose: the Universe has no other reason to need one.
 */
export function useRoomStationsOnMap(scope: AccountScope): readonly RoomStation[] {
  const [stations, setStations] = useState<readonly RoomStation[]>([]);
  useFocusEffect(
    useCallback(() => {
      let current = true;
      void readRoomStations(scope, newCommandId).then(
        (found) => {
          if (current) setStations(found);
        },
        () => undefined,
      );
      return () => {
        current = false;
      };
    }, [scope]),
  );
  return stations;
}
