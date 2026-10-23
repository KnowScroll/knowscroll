import { useFonts } from 'expo-font';
import { useEffect, useState } from 'react';
import { Text } from 'react-native';
import type {
  nativeDurabilityBootstrap as Bootstrap,
  NativeBootstrap,
} from '../features/gallery/native-durability-bootstrap';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { DisplayRoot } from '@knowscroll/ui';
import { AccountScopeProvider } from '../providers/account-scope';
import { fontFamilies } from '../theme/fonts';

type BootstrapModule = { nativeDurabilityBootstrap: typeof Bootstrap };
const ciBootstrap =
  process.env.EXPO_PUBLIC_KS_GALLERY === '1' && process.env.EXPO_PUBLIC_KS_NATIVE_DURABILITY_CI === '1'
    ? // eslint-disable-next-line @typescript-eslint/no-require-imports -- Exclude synthetic authority before normal provider construction.
      (require('../features/gallery/native-durability-bootstrap') as BootstrapModule).nativeDurabilityBootstrap
    : null;

/**
 * Root layout: nothing renders until the bundled fonts are loaded, so text never reflows. The
 * display (window, text size, reduce motion) is read once here for every component. The
 * AccountScope (#226) reads the session once, then gives the tree the query client of the
 * signed-in scope (one per account and privacy epoch) or of the signed-out period, and remounts
 * the tree when that changes, so no state of one account survives into another.
 */
export default function RootLayout() {
  const [bootstrap, setBootstrap] = useState<NativeBootstrap>();
  useEffect(() => {
    if (ciBootstrap) void ciBootstrap().then(setBootstrap);
  }, []);
  const [loaded, error] = useFonts(fontFamilies);
  if (!loaded && error === null) return null;
  if (ciBootstrap && bootstrap === undefined) return <Text testID="native249-bootstrap-wait">CI bootstrap</Text>;
  if (ciBootstrap && bootstrap?.kind !== 'ready')
    return <Text testID="native249-bootstrap-unavailable">CI bootstrap unavailable</Text>;
  return (
    <DisplayRoot>
      <AccountScopeProvider {...(bootstrap?.kind === 'ready' ? { manager: bootstrap.harness.manager } : {})}>
        <StatusBar style="auto" />
        <Stack screenOptions={{ headerShown: false }} />
      </AccountScopeProvider>
    </DisplayRoot>
  );
}
