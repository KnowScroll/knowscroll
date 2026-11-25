/**
 * The per-device switches of the Universe's trial: whether this device draws the Universe's new look, and whether it
 * shows the frame-rate readout. Both are chosen in Settings → Accessibility, kept on the device only (never on the
 * account), off by default, and read only by the Universe screen.
 */
import { useDevicePreferences } from '../../providers/device-preferences';

/** What this device chose for the Universe: `on` is the new look, `frameRate` the readout. */
export function useUniverseTrial(): { readonly on: boolean; readonly frameRate: boolean } {
  const { preferences } = useDevicePreferences();
  return { on: preferences.universeTrial, frameRate: preferences.universeFrameRate };
}
