import { createContext, useContext } from 'react';
import type { FocusHalo } from '@knowscroll/design-tokens';

/**
 * Set by a screen that lays its own ground under controls (a room's): which halo the cobalt focus ring needs there to reach 3:1,
 * or nothing on a ground where cobalt reads alone. `useFocusRing('onLight')` draws it; a ring asked for as `onDark` is unchanged.
 */
const FocusHaloContext = createContext<FocusHalo | undefined>(undefined);

export const FocusHaloProvider = FocusHaloContext.Provider;

export const useFocusHalo = (): FocusHalo | undefined => useContext(FocusHaloContext);
