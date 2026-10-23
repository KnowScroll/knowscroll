import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { DisplayRoot } from '@knowscroll/ui';
import { AccountScopeProvider } from '../providers/account-scope';
import { fontFamilies } from '../theme/fonts';

/**
 * Root layout: nothing renders until the bundled fonts are loaded, so text never reflows. The
 * display (window, text size, reduce motion) is read once here for every component. The
 * AccountScope (#226) reads the session once, then gives the tree the query client of the
 * signed-in scope (one per account and privacy epoch) or of the signed-out period, and remounts
 * the tree when that changes, so no state of one account survives into another.
 */
export default function RootLayout() {
  const [loaded, error] = useFonts(fontFamilies);
  if (!loaded && error === null) return null;
  return (
    <DisplayRoot>
      <AccountScopeProvider>
        <StatusBar style="auto" />
        <Stack screenOptions={{ headerShown: false }} />
      </AccountScopeProvider>
    </DisplayRoot>
  );
}
