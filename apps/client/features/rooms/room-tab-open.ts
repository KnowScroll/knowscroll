import { createContext, useContext } from 'react';

/**
 * Whether the room tab this component sits in is the one the person is looking at, and the room is the screen in front. A room's
 * tabs stay mounted so each keeps its scroll, which would otherwise leave a hidden tab polling, playing and recording. Outside a
 * tab (a discussion page, the rail, a sheet) it is `true`: such a part is on screen whenever it is mounted.
 */
const RoomTabOpenContext = createContext(true);

export const RoomTabOpenProvider = RoomTabOpenContext.Provider;

/** True while the tab holding this component is open and the room is the focused screen. */
export const useRoomTabOpen = (): boolean => useContext(RoomTabOpenContext);
