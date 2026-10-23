import { useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { layout, spacing } from '@knowscroll/design-tokens';
import { useDisplay } from '@knowscroll/ui';
import { usesRail } from '../shell/app-navigation';

/** The widest a Reel column grows: a 9:16 stage on a desktop is a column, never a stretched frame. */
const REEL_COLUMN_MAX = 480;

export interface EncounterMetrics {
  /** Distance the screen's own chrome keeps from the status bar. */
  readonly top: number;
  /** Space the floating tab bar takes at the bottom (0 where a rail is used). */
  readonly bottom: number;
  /** Side inset: the phone gutter, plus the notch in landscape. */
  readonly side: number;
  /** Height at which the rail and the title block no longer fit above the progress row. */
  readonly short: boolean;
  readonly compact: boolean;
  readonly railed: boolean;
  readonly reelColumn: number;
}

/** Where encounter chrome may sit: below the status bar, clear of the tab bar or rail. */
export function useEncounterMetrics(): EncounterMetrics {
  const insets = useSafeAreaInsets();
  const { breakpoint } = useDisplay();
  const { height, width } = useWindowDimensions();
  const railed = usesRail(breakpoint);
  return {
    top: insets.top + spacing[3],
    bottom: railed ? insets.bottom : layout.tabBarSlot + insets.bottom,
    side: layout.topControlsInset + (railed ? 0 : insets.left),
    short: height < 640,
    compact: breakpoint === 'compact',
    railed,
    reelColumn: Math.min(width, REEL_COLUMN_MAX),
  };
}
