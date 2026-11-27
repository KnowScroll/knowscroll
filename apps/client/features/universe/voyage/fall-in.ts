import { createContext } from 'react';
import type { FallIn } from './voyage-control';

/**
 * How far out a friend's Universe is entered from once the crossing film hands over: the prototype puts the camera at
 * seven times the friend's top stop and flies it in with no ship (`go`), about 1.6 s the first time and 0.9 s after.
 */
export const CROSSING_FALL_SCALE = 7;

/**
 * The fall the trial's stage should make into its stop, given by the screen round it (the visit, once the film hands
 * over). A context, as the frame-rate readout's recorders are, because the stage sits under the surface that your own
 * Universe and a friend's both mount, and only the visit ever asks for a fall.
 */
export const FallInContext = createContext<FallIn | null>(null);
