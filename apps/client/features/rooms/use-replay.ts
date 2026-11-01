import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  createRoomReplay,
  type AccountScope,
  type RoomReplayController,
  type RoomReplayState,
} from '@knowscroll/client-core';
import { newCommandId } from '../../platform/command-id';
import { steadyClock } from './use-launch';

/**
 * One room's replay of a finished Launch. It reads what can be replayed each time the sheet opens (`enabled`) and never otherwise: a
 * replay is not polled, keeps nothing about the person, and a room with nothing to replay asks nothing. A device clock decides nothing;
 * the seconds of a question are counted on a steady clock from the moment it was shown.
 */
export function useRoomReplay(
  scope: AccountScope,
  roomId: string,
  enabled: boolean,
): { controller: RoomReplayController; state: RoomReplayState } {
  const [controller] = useState(() => createRoomReplay({ scope, roomId, newId: newCommandId, clock: steadyClock }));
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  useEffect(() => {
    if (enabled) void controller.load();
  }, [enabled, controller]);
  return { controller, state };
}
