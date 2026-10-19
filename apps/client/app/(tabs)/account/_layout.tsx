import { Stack } from 'expo-router';

/** The account stack: settings pages (P01–P03, D05) push here as they are built. */
export default function AccountLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
