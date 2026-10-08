#!/usr/bin/env node
// Builds one release of KnowScroll for the server (#201): every backend program bundled with all
// of its dependencies (no node_modules on the server, no npm during a deploy), the web bundle, the
// migrations and the editorial content, plus release.json and release.env, as one tarball.
//
//   node scripts/build-release.mjs --out <dir> [--commit <sha>]
//
// The same release is promoted dev → stage → live unchanged; nothing in it names a world.
// Runtime paths in the programs are relative to the working directory (packages/db/migrations,
// content/), so the tarball keeps those folders beside dist/.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { builtinModules } from 'node:module';
import { join, relative, resolve } from 'node:path';
import { build } from 'esbuild';

const PROGRAMS = {
  api: 'apps/api/src/main.ts',
  worker: 'apps/worker/src/main.ts',
  generation: 'apps/worker/src/generation/main.ts',
  maintenance: 'apps/worker/src/reasoning/maintenance-main.ts',
  migrate: 'scripts/migrate.ts',
  seed: 'scripts/seed.ts',
  // #199: the shared Reel pool's own migrations, and the operator commands `ks run` offers.
  'migrate-pool': 'scripts/migrate-pool.ts',
  'generation-cli': 'scripts/generation.ts',
  publication: 'apps/worker/src/publication/cli.ts',
  'install-supply': 'scripts/scrolls/install-supply.ts',
};

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const out = argument('out');
if (!out) {
  console.error(
    'usage: node scripts/build-release.mjs --out <dir> [--commit <sha>]',
  );
  process.exit(2);
}
const commit =
  argument('commit') ??
  execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (!/^[0-9a-f]{40}$/.test(commit)) {
  console.error(`--commit must be a 40-character hex commit; got ${commit}`);
  process.exit(2);
}

const root = resolve(out, commit);
mkdirSync(resolve(out), { recursive: true });
// Not recursive: a release folder that already exists is never overwritten.
mkdirSync(root);

const result = await build({
  entryPoints: PROGRAMS,
  outdir: join(root, 'dist'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  outExtension: { '.js': '.mjs' },
  // CommonJS dependencies inside an ESM bundle still call require().
  banner: {
    js: "import { createRequire as __ksRequire } from 'node:module'; const require = __ksRequire(import.meta.url);",
  },
  metafile: true,
  logLevel: 'warning',
});

// Every import must be inside the bundle: the server has no node_modules to fall back on. Node's
// own modules are fine, and so is pg's optional native addon, which pg loads only when native
// mode is requested (pg.native) — KnowScroll never requests it.
const NODE_BUILTINS = new Set(builtinModules);
const OPTIONAL_NEVER_LOADED = new Set(['pg-native']);
const unbundled = Object.values(result.metafile.outputs)
  .flatMap((output) => output.imports)
  .filter(
    (entry) =>
      entry.external &&
      !entry.path.startsWith('node:') &&
      !NODE_BUILTINS.has(entry.path) &&
      !OPTIONAL_NEVER_LOADED.has(entry.path),
  )
  .map((entry) => entry.path);
if (unbundled.length > 0) {
  console.error(
    `imports left outside the bundle: ${[...new Set(unbundled)].join(', ')}`,
  );
  process.exit(1);
}

execFileSync(
  'pnpm',
  [
    '--filter',
    'web',
    'exec',
    'vite',
    'build',
    '--outDir',
    join(root, 'web'),
    '--emptyOutDir',
  ],
  { stdio: 'inherit' },
);

mkdirSync(join(root, 'packages', 'db'), { recursive: true });
cpSync('packages/db/migrations', join(root, 'packages', 'db', 'migrations'), {
  recursive: true,
});
cpSync(
  'packages/db/pool-migrations',
  join(root, 'packages', 'db', 'pool-migrations'),
  { recursive: true },
);
cpSync('content', join(root, 'content'), { recursive: true });

const bundles = Object.fromEntries(
  Object.keys(PROGRAMS).map((name) => [
    `dist/${name}.mjs`,
    sha256(join(root, 'dist', `${name}.mjs`)),
  ]),
);
const migrations = readdirSync(join(root, 'packages', 'db', 'migrations'))
  .filter((name) => name.endsWith('.sql'))
  .sort();
writeFileSync(
  join(root, 'release.json'),
  `${JSON.stringify(
    {
      commit,
      builtAt: new Date().toISOString(),
      node: process.version,
      bundles,
      migrations,
    },
    null,
    2,
  )}\n`,
);
writeFileSync(join(root, 'release.env'), `KS_COMMIT=${commit}\n`);

const tarball = resolve(out, `release-${commit}.tar`);
// COPYFILE_DISABLE keeps macOS tar from adding AppleDouble files when a release is built locally.
execFileSync('tar', ['-C', root, '-cf', tarball, '.'], {
  env: { ...process.env, COPYFILE_DISABLE: '1' },
});
const digest = sha256(tarball);
writeFileSync(
  `${tarball}.sha256`,
  `${digest}  ${relative(resolve(out), tarball)}\n`,
);
console.log(
  JSON.stringify({
    release: tarball,
    sha256: digest,
    commit,
    programs: Object.keys(PROGRAMS),
  }),
);
