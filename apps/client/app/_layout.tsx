import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { DisplayRoot } from '@knowscroll/ui';
import { AccountScopeProvider } from '../providers/account-scope';
import { DevicePreferencesProvider, PreferredDisplay, PreferredTalkTheme } from '../providers/device-preferences';
import { fontFamilies } from '../theme/fonts';

/**
 * Root layout: nothing renders until the bundled fonts are loaded, so text never reflows. The
 * display (window, text size, reduce motion) is read once here for every component, with the
 * person's own device choices laid over it (Account: Accessibility & playback), and the Talk theme
 * they chose (dark sky or Paper) is named once for every Talk screen. The
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
          <PreferredTalkTheme>
            <AccountScopeProvider>
              <StatusBar style="auto" />
              <Stack screenOptions={{ headerShown: false }} />
            </AccountScopeProvider>
          </PreferredTalkTheme>
        </PreferredDisplay>
      </DevicePreferencesProvider>
    </DisplayRoot>
  );
}
