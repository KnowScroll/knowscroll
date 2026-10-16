/**
 * Proves the ADR-0022 no-token-in-bundle rule directly
 * against a real `vite build` invocation (not a mock of the plugin), per
 * the #92 brief: "add a test that greps the built client output for the
 * token and for 'Authorization'".
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Deliberately not `new URL('../../', import.meta.url)`: Vite statically
// rewrites that literal two-argument form into a dev-server asset URL even
// inside test files, which breaks a Node-side path lookup like this one.
const here = fileURLToPath(import.meta.url);
const webRoot = join(dirname(here), '..', '..');
const viteBin = join(webRoot, 'node_modules', 'vite', 'bin', 'vite.js');

function textFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...textFiles(full));
    } else if (/\.(js|mjs|cjs|css|html|map|json)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe('production build and secret-free bundle (ADR-0022, #201)', () => {
  // ADR-0022 refused production builds while no production identity existed. Magic-link and
  // cookie sign-in (#2, ADR-0026/0034) now exist, and #201 serves the built bundle per world, so a
  // plain `vite build` must succeed. What never changes: no token reaches the bundle.
  it('a plain production build succeeds and never contains a dev token or an Authorization reference', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'ks-web-build-'));
    const secretToken = 'unit-test-secret-token-must-never-leak-into-the-client-bundle';
    try {
      execFileSync('node', [viteBin, 'build', '--outDir', outDir], {
        cwd: webRoot,
        env: {
          ...process.env,
          KS_DEV_TOKEN: secretToken,
          KS_WEB_API_URL: 'http://127.0.0.1:1',
        },
        stdio: 'pipe',
      });
      const files = textFiles(outDir);
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        const contents = readFileSync(file, 'utf8');
        expect(contents).not.toContain(secretToken);
        expect(contents).not.toMatch(/Authorization/);
      }
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }, 60_000);
});
