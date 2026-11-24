import { useDevicePreferences } from '../../providers/device-preferences';

/** What this device chose for the Universe: the new look on trial, and a frame-rate readout. */
export function useUniverseTrial(): { readonly on: boolean; readonly frameRate: boolean } {
  const { preferences } = useDevicePreferences();
  return { on: preferences.universeTrial, frameRate: preferences.universeFrameRate };
}
