/**
 * ADR-0022 dev-auth proxy.
 *
 * The Vite dev/preview server binds 127.0.0.1 only and proxies `/v1/*` to a
 * configured loopback API (`KS_WEB_API_URL`), injecting `Authorization:
 * Bearer <token>` from `KS_DEV_TOKEN` on the outgoing proxied request only.
 * Both env vars are read here, in vite.config.ts (a Node-side file that is
 * never bundled for the browser) via `process.env`; neither name is ever
 * passed through `define`, `envPrefix`, or `import.meta.env`, so the token
 * cannot reach client JavaScript, the built bundle, or browser storage.
 *
 * `vite build` (production bundling) refuses by default: production
 * identity (#2) does not exist, so there is no authenticated way to serve a
 * built bundle in a non-development context. The only supported way to run
 * this app is `vite dev` or `vite preview`, both of which are Node
 * processes that apply the same loopback + injected-token rule. A single
 * internal escape hatch (`KS_WEB_ALLOW_BUILD_FOR_TEST_EVIDENCE=1`) exists
 * solely so a test can build the client bundle and grep its own output for
 * a leaked token/Authorization header (see test/unit/build-no-secrets.test.ts);
 * it is never set by `pnpm build`, `pnpm --filter web build`, or CI.
 */
import react from '@vitejs/plugin-react';
import type { IncomingMessage } from 'node:http';
import { defineConfig, type Plugin, type PreviewServer, type ProxyOptions, type ViteDevServer } from 'vite';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname);
}

function refuseProductionBuild(): Plugin {
  return {
    name: 'ks-refuse-production-build',
    apply: 'build',
    buildStart() {
      if (process.env.KS_WEB_ALLOW_BUILD_FOR_TEST_EVIDENCE === '1') return;
      throw new Error(
        'apps/web has no production identity yet (#2, see docs/decisions/0022-desktop-web-surface.md). ' +
          '`vite build` refuses to produce a bundle; run `pnpm --filter web dev` or `pnpm --filter web preview` ' +
          'against a loopback API instead.',
      );
    },
  };
}

/** Both `vite dev` and `vite preview` must stay bound to loopback even if a CLI --host flag is added later. */
function enforceLoopbackBinding(): Plugin {
  const guard = (server: ViteDevServer | PreviewServer) => {
    const httpServer = server.httpServer;
    if (!httpServer) return;
    httpServer.once('listening', () => {
      const address = httpServer.address();
      const hostname = typeof address === 'string' ? address : address?.address;
      if (hostname && !isLoopbackHost(hostname) && hostname !== '0.0.0.0' /* bound-all still resolves loopback-reachable, but is refused below via server.host */) {
        // eslint-disable-next-line no-console
        console.error(`Refusing non-loopback bind (${hostname}). Development authentication only serves 127.0.0.1.`);
        httpServer.close();
        process.exitCode = 1;
      }
    });
  };
  return {
    name: 'ks-enforce-loopback-binding',
    configureServer(server) {
      guard(server);
    },
    configurePreviewServer(server) {
      guard(server);
    },
  };
}

function devAuthProxy(): Record<string, string | ProxyOptions> {
  const apiUrl = process.env.KS_WEB_API_URL;
  const token = process.env.KS_DEV_TOKEN;
  if (!apiUrl || !token) {
    // No proxy target configured: /v1 requests will 404 from Vite's own server
    // rather than silently succeeding unauthenticated against some default.
    return {};
  }
  const target = new URL(apiUrl);
  if (!isLoopbackHost(target.hostname)) {
    throw new Error(`KS_WEB_API_URL must be a loopback address for development authentication; got ${target.hostname}`);
  }
  return {
    '/v1': {
      target: target.origin,
      changeOrigin: true,
      configure(proxy) {
        proxy.on('proxyReq', proxyReq => {
          proxyReq.setHeader('Authorization', `Bearer ${token}`);
        });
        proxy.on('error', (error: Error, _req: IncomingMessage) => {
          // eslint-disable-next-line no-console
          console.error('[dev-auth-proxy] upstream API error', error.message);
        });
      },
    },
  };
}

export default defineConfig(() => {
  const proxy = devAuthProxy();
  return {
    plugins: [react(), refuseProductionBuild(), enforceLoopbackBinding()],
    server: {
      host: '127.0.0.1',
      port: Number(process.env.PORT) || 4392,
      strictPort: true,
      proxy,
      // Playwright writes its own HTML/JSON report and trace files under
      // apps/web/artifacts/** *during* a journey run. Without this, Vite's
      // watcher treats those writes as source changes and force-reloads the
      // page mid-test, aborting in-flight requests non-deterministically.
      watch: { ignored: ['**/artifacts/**'] },
    },
    preview: {
      host: '127.0.0.1',
      port: Number(process.env.PORT) || 4392,
      strictPort: true,
      proxy,
    },
  };
});
