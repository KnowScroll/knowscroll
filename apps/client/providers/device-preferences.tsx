import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { talkThemeForAppearance } from '@knowscroll/design-tokens';
import { DisplayProvider, TalkThemeProvider, useDisplay } from '@knowscroll/ui';
import {
  defaultDevicePreferences,
  needsRewrite,
  parseDevicePreferences,
  textSizeFactor,
  type DevicePreferences,
} from '../features/account/device-preferences';
import { paintAppearance } from '../platform/appearance-page';
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
  // A value kept before Appearance (D-151's `talkTheme`) is written once in today's shape, so the carried-over choice
  // is the only theme preference on this device (#666).
  const [migrate] = useState(() => initial === undefined && needsRewrite(devicePreferencesStore.read()));
  const first = useRef(preferences);
  useEffect(() => {
    if (migrate) devicePreferencesStore.write(JSON.stringify(first.current));
  }, [migrate]);
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

/** Layout effects need a DOM; the native and test renderers run the same work as an ordinary effect. */
const useIsomorphicLayoutEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect;

/**
 * Applies the person's Appearance (#666) to everything below it: on the web the page is named Light
 * or Dark, which repaints every adaptive colour role at once; Talk's own role set follows it (Paper
 * in Light, the sky in Dark, D-145), so no component reads the setting.
 */
export function PreferredAppearance({ children }: { readonly children: ReactNode }) {
  const { preferences } = useDevicePreferences();
  // Before the first paint, so a Dark page never flashes Light.
  useIsomorphicLayoutEffect(() => paintAppearance(preferences.appearance), [preferences.appearance]);
  return <TalkThemeProvider name={talkThemeForAppearance[preferences.appearance]}>{children}</TalkThemeProvider>;
}
