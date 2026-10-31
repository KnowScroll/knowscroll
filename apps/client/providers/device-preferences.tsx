import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { DisplayProvider, TalkThemeProvider, useDisplay } from '@knowscroll/ui';
import {
  defaultDevicePreferences,
  parseDevicePreferences,
  textSizeFactor,
  type DevicePreferences,
} from '../features/account/device-preferences';
import { devicePreferencesStore } from '../platform/device-preferences-store';

interface DevicePreferencesValue {
  readonly preferences: DevicePreferences;
  /** Applies a change at once and keeps it on this device. */
  readonly update: (change: Partial<DevicePreferences>) => void;
}

const DevicePreferencesContext = createContext<DevicePreferencesValue>({
  preferences: defaultDevicePreferences,
  update: () => undefined,
});

/**
 * This device's display and playback choices (Account: Accessibility & playback, Notifications).
 * Mounted once at the root, above the account scope: they belong to the device, so signing out,
 * switching account and a privacy clear leave them alone.
 */
export function DevicePreferencesProvider({
  children,
  initial,
}: {
  readonly children: ReactNode;
  /** Pins the starting choices (tests); the app reads them from this device. */
  readonly initial?: DevicePreferences;
}) {
  const [preferences, setPreferences] = useState(
    () => initial ?? parseDevicePreferences(devicePreferencesStore.read()),
  );
  const update = useCallback(
    (change: Partial<DevicePreferences>) => {
      const next = { ...preferences, ...change };
      setPreferences(next);
      devicePreferencesStore.write(JSON.stringify(next));
    },
    [preferences],
  );
  const value = useMemo(() => ({ preferences, update }), [preferences, update]);
  return <DevicePreferencesContext.Provider value={value}>{children}</DevicePreferencesContext.Provider>;
}

export function useDevicePreferences(): DevicePreferencesValue {
  return useContext(DevicePreferencesContext);
}

/**
 * Lays the person's own motion and text size choices over what the system reports, for every
 * component below it. The system's reduce-motion setting is never overridden toward more motion.
 */
export function PreferredDisplay({ children }: { readonly children: ReactNode }) {
  const display = useDisplay();
  const { preferences } = useDevicePreferences();
  return (
    <DisplayProvider
      value={{
        reducedMotion: display.reducedMotion || preferences.motion === 'reduce',
        textScale: display.textScale * textSizeFactor[preferences.textSize],
      }}
    >
      {children}
    </DisplayProvider>
  );
}

/**
 * Gives every Talk screen below it the theme the person chose on this device: the dark sky, or Paper for long
 * reading (D-151). The components read their colours from the theme, so none of them knows the setting.
 */
export function PreferredTalkTheme({ children }: { readonly children: ReactNode }) {
  const { preferences } = useDevicePreferences();
  return <TalkThemeProvider name={preferences.talkTheme}>{children}</TalkThemeProvider>;
}
