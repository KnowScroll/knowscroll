import { createContext } from 'react';
import type { RoomController, RoomState } from '@knowscroll/client-core';

/**
 * What a room's desktop layout (D04) shares with the screen in its centre: the one room controller, so
 * a join or leave in the centre changes the panes at once instead of after the next poll, and whether
 * the three panes are showing (they do only for a member; an outsider sees the preview alone).
 */
export interface RoomWorkspaceValue {
  readonly controller: RoomController;
  readonly state: RoomState;
  readonly panes: boolean;
}

export const RoomWorkspaceContext = createContext<RoomWorkspaceValue | undefined>(undefined);
