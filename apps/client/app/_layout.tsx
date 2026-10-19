import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { fontAssets } from '../theme/fonts';

/** Root layout: nothing renders until the bundled fonts are loaded, so text never reflows. */
export default function RootLayout() {
  const [loaded, error] = useFonts(fontAssets);
  if (!loaded && error === null) return null;
  return (
    <>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerShown: false }} />
    </>
  );
}
