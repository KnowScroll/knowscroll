import { Platform } from 'react-native';
import { createApiClient, resolveApiOrigin, type ApiClient, type ApiOrigin } from '@knowscroll/client-core';

/**
 * Where this build reaches the API (D-008): the page's own origin on the web; on Android and iOS
 * the world origin baked in at build time as `EXPO_PUBLIC_KS_API_ORIGIN` (HTTPS; production
 * builds refuse plain HTTP).
 */
export function appApiOrigin(): ApiOrigin {
  if (Platform.OS === 'web') {
    return resolveApiOrigin({ platform: 'web', pageOrigin: typeof location === 'undefined' ? '' : location.origin });
  }
  // Plain HTTP (to localhost or the emulator's 10.0.2.2) only in development builds and in a build
  // made for a test API (`EXPO_PUBLIC_KS_TEST_API=1`, the native lane's journeys).
  return resolveApiOrigin({
    platform: 'native',
    configuredOrigin: process.env.EXPO_PUBLIC_KS_API_ORIGIN,
    allowDevelopmentHttp: __DEV__ || process.env.EXPO_PUBLIC_KS_TEST_API === '1',
  });
}

/** The typed API client for this build, or why there is none. */
export function appApiClient():
  { readonly ok: true; readonly api: ApiClient; readonly baseUrl: string } | Extract<ApiOrigin, { ok: false }> {
  const origin = appApiOrigin();
  if (!origin.ok) return origin;
  return { ok: true, api: createApiClient({ baseUrl: origin.baseUrl }), baseUrl: origin.baseUrl };
}
