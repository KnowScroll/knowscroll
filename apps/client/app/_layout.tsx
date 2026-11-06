import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { DisplayRoot } from '@knowscroll/ui';
import { AccountScopeProvider } from '../providers/account-scope';
import { parseDevicePreferences } from '../features/account/device-preferences';
import { paintAppearance } from '../platform/appearance-page';
import { devicePreferencesStore } from '../platform/device-preferences-store';
import { DevicePreferencesProvider, PreferredAppearance, PreferredDisplay } from '../providers/device-preferences';
import { fontFamilies } from '../theme/fonts';

// The web page takes the stored appearance while the fonts load, so a Dark page never shows Light first.
paintAppearance(parseDevicePreferences(devicePreferencesStore.read()).appearance);

/**
 * Root layout: nothing renders until the bundled fonts are loaded, so text never reflows. The
 * display (window, text size, reduce motion) is read once here for every component, with the
 * person's own device choices laid over it (Account: Accessibility & playback), and the Appearance
 * they chose (Light or Dark, Account: Appearance, #666) is applied once for the whole app. The
 * AccountScope (#226) reads the session once, then gives the tree the query client of the
 * signed-in scope (one per account and privacy epoch) or of the signed-out period, and remounts
 * the tree when that changes, so no state of one account survives into another.
 */
export default function RootLayout() {
  const [loaded, error] = useFonts(fontFamilies);
  if (!loaded && error === null) return null;
  return (
    <DisplayRoot>
      <DevicePreferencesProvider>
        <PreferredDisplay>
          <PreferredAppearance>
            <AccountScopeProvider>
              <StatusBar style="auto" />
              <Stack screenOptions={{ headerShown: false }} />
            </AccountScopeProvider>
          </PreferredAppearance>
        </PreferredDisplay>
      </DevicePreferencesProvider>
    </DisplayRoot>
  );
}
