import { QueryClientProvider } from '@tanstack/react-query';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { createQueryClient } from '@knowscroll/client-core';
import { fontFamilies } from '../theme/fonts';

/**
 * Root layout: nothing renders until the bundled fonts are loaded, so text never reflows. The
 * query client here serves operations reads (the dev health check) only; account-scoped data gets
 * its own client per (account, privacy epoch) from the AccountScope (#226).
 */
export default function RootLayout() {
  const [loaded, error] = useFonts(fontFamilies);
  const [queryClient] = useState(createQueryClient);
  if (!loaded && error === null) return null;
  return (
    <QueryClientProvider client={queryClient}>
      <StatusBar style="auto" />
      <Stack screenOptions={{ headerShown: false }} />
    </QueryClientProvider>
  );
}
