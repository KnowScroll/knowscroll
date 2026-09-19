import { test as base, expect } from '@playwright/test';

/**
 * Node-side test fixtures. `apiToken`/`apiBase` exist only in this test
 * process (never sent to the page/browser) so a spec can verify server-side
 * truth directly -- e.g. "exposure recorded exactly once" -- without
 * inventing a second source of truth. The fault-proxy control channel lets a
 * spec provoke a real transport failure against the real disposable API.
 */
export interface JourneyFixtures {
  faultProxyUrl: string;
  apiBase: string;
  apiToken: string;
  apiFetch: (path: string, init?: RequestInit) => Promise<Response>;
  armDrop: (method: string, path: string) => Promise<void>;
  armInvalidateAuth: (method: string, path: string) => Promise<void>;
  setOutage: (enabled: boolean) => Promise<void>;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required; set by scripts/run-web-reader-journey.ts`);
  return value;
}

export const test = base.extend<JourneyFixtures>({
  faultProxyUrl: async ({}, use) => {
    await use(requiredEnv('KS_FAULT_PROXY_URL'));
  },
  apiBase: async ({}, use) => {
    await use(requiredEnv('KS_TEST_API_BASE'));
  },
  apiToken: async ({}, use) => {
    await use(requiredEnv('KS_TEST_API_TOKEN'));
  },
  apiFetch: async ({ apiBase, apiToken }, use) => {
    await use((path: string, init: RequestInit = {}) =>
      fetch(`${apiBase}${path}`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${apiToken}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) } }),
    );
  },
  armDrop: async ({ faultProxyUrl }, use) => {
    await use(async (method: string, path: string) => {
      const response = await fetch(`${faultProxyUrl}/__control__/arm-drop`, { method: 'POST', body: JSON.stringify({ method, path }) });
      if (response.status !== 204) throw new Error('fault-proxy arm-drop failed');
    });
  },
  armInvalidateAuth: async ({ faultProxyUrl }, use) => {
    await use(async (method: string, path: string) => {
      const response = await fetch(`${faultProxyUrl}/__control__/arm-invalidate-auth`, { method: 'POST', body: JSON.stringify({ method, path }) });
      if (response.status !== 204) throw new Error('fault-proxy arm-invalidate-auth failed');
    });
  },
  setOutage: async ({ faultProxyUrl }, use) => {
    await use(async (enabled: boolean) => {
      const response = await fetch(`${faultProxyUrl}/__control__/outage`, { method: 'POST', body: JSON.stringify({ enabled }) });
      if (response.status !== 204) throw new Error('fault-proxy outage toggle failed');
    });
  },
});

export { expect };
