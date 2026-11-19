import type { ComponentRef, RefObject } from 'react';
import type { View } from 'react-native';
import type { CoverMoves } from './cover-paging.web';

export type { CoverMoves };

/**
 * Covers are a web trial (#745, Android is #740): on a native device a cover is turned and opened with its own
 * buttons, and the platform's Back goes through the encounter's Back as everywhere else.
 */
export function useCoverPaging(
  _rootRef: RefObject<ComponentRef<typeof View> | null>,
  _enabled: boolean,
  _moves: CoverMoves,
) {
  // Nothing to bind natively.
}
