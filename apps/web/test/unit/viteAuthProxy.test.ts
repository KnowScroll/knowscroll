/**
 * ADR-0034 -- the dev/preview proxy's two auth modes. `defineConfig()` is Vite's own identity
 * function for a config *factory*, so the module's default export is exactly the `() => {...}`
 * function `vite.config.ts` defines; calling it directly (as Vite itself would, at serve/build
 * time) re-reads `process.env` fresh on every call, with no module-cache tricks needed between
 * assertions in the same test file.
 *
 * The default (unset `KS_WEB_AUTH`) behaviour is exercised already by
 * test/unit/build-no-secrets.test.ts's real `vite build` run; this file only adds the one new
 * switch (`KS_WEB_AUTH=cookie`) and proves the default keeps requiring `KS_DEV_TOKEN` exactly as
 * before it existed.
 */
import { afterEach, describe, expect, it } from 'vitest';

type ViteConfigFactory = (env: { command: 'serve' | 'build'; mode: string }) => {
  server: { proxy: Record<string, unknown> };
};

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
});

/**
 * `vite.config.ts` belongs to the sibling `tsconfig.node.json` project (it is Node-side
 * configuration, never bundled for the browser), not this `tsconfig.app.json` one that
 * `test/unit` lives under -- and both projects deliberately use `noEmit`, which TS project
 * references refuse to bridge (TS6310). vitest itself resolves this import fine at runtime (its
 * own Vite-powered pipeline, independent of tsc's project graph); building the specifier from a
 * join rather than a literal keeps tsc from trying to add the file to *this* project's program at
 * all, so the two intentionally-separate `noEmit` projects never need to reference each other.
 */
const VITE_CONFIG_PATH = ['..', '..', 'vite.config.ts'].join('/');
async function loadConfigFactory(): Promise<ViteConfigFactory> {
  const mod: { default: ViteConfigFactory } = await import(VITE_CONFIG_PATH);
  return mod.default;
}

describe('dev/preview proxy auth mode (ADR-0034, KS_WEB_AUTH)', () => {
  it('defaults to bearer mode unchanged: no proxy at all without KS_DEV_TOKEN', async () => {
    const configFactory = await loadConfigFactory();
    process.env.KS_WEB_API_URL = 'http://127.0.0.1:1';
    delete process.env.KS_DEV_TOKEN;
    delete process.env.KS_WEB_AUTH;
    const config = configFactory({ command: 'serve', mode: 'development' });
    expect(config.server.proxy).toEqual({});
  });

  it('bearer mode (KS_WEB_AUTH unset) proxies once KS_DEV_TOKEN is present, exactly as before', async () => {
    const configFactory = await loadConfigFactory();
    process.env.KS_WEB_API_URL = 'http://127.0.0.1:1';
    process.env.KS_DEV_TOKEN = 'a'.repeat(32);
    delete process.env.KS_WEB_AUTH;
    const config = configFactory({ command: 'serve', mode: 'development' });
    expect(config.server.proxy['/v1']).toBeTruthy();
  });

  it('KS_WEB_AUTH=cookie proxies without requiring KS_DEV_TOKEN', async () => {
    const configFactory = await loadConfigFactory();
    process.env.KS_WEB_API_URL = 'http://127.0.0.1:1';
    process.env.KS_WEB_AUTH = 'cookie';
    delete process.env.KS_DEV_TOKEN;
    const config = configFactory({ command: 'serve', mode: 'development' });
    expect(config.server.proxy['/v1']).toBeTruthy();
  });

  it('KS_WEB_AUTH=cookie still refuses with no proxy target at all', async () => {
    const configFactory = await loadConfigFactory();
    delete process.env.KS_WEB_API_URL;
    process.env.KS_WEB_AUTH = 'cookie';
    delete process.env.KS_DEV_TOKEN;
    const config = configFactory({ command: 'serve', mode: 'development' });
    expect(config.server.proxy).toEqual({});
  });
});
