#!/usr/bin/env node
// Assembles one KnowScroll v2 release from a built workspace (#228, docs/v2/operations/environments.md).
//
//   node scripts/release/build.mjs --out <dir> [--commit <sha>] [--config <file.json>]
//                                  [--built-at <ISO time>] [--keep-staging]
//
// Run it after the workspace is built (`nest build` for the API and worker, `expo export
// --platform web` for the client). It writes <out>/release-<commit>.tar and
// <out>/release-<commit>.tar.sha256 and prints the tar's sha256 as its last line. The tar's root:
//
//   release.json   { schema: "ks-release.v2", commit, builtAt, node, programs, migrate, web, migrations }
//   files.sha256   sha256sum lines for every file in the release except itself
//   api/, worker/  `pnpm --filter <package> deploy --prod --legacy` output (package.json, dist/, node_modules/)
//   web/           the Expo web export
//
// Nothing in it names a world: the same bytes go to dev and then to stage. The server
// (ops/vps/tool) and scripts/release/smoke.mjs check it with the same rules (ops/vps/tool/plan.ts),
// and the release is checked against them here before it is packed.
//
// The layout comes from DEFAULTS below; a JSON --config may replace `programs`, `migrate`, `web`
// and `migrations`. A program may name `from` (a folder already prepared) instead of `package`.

import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  checkFileList,
  isSafeFilePath,
  V2_PROGRAMS,
  V2_SCHEMA,
  validateV2Manifest,
} from '../../ops/vps/tool/plan.ts';
import { gnuTar, hashTree, sha256Stream } from './files.mjs';

const DEFAULTS = {
  programs: {
    api: {
      package: '@knowscroll/api',
      exec: ['node', '--enable-source-maps', 'dist/main.js'],
    },
    worker: {
      package: '@knowscroll/worker',
      exec: ['node', '--enable-source-maps', 'dist/main.js'],
    },
  },
  // Runs in the named program's folder, with that program's node_modules.
  migrate: { program: 'api', exec: ['node', 'dist/migrate.js'] },
  // The Expo web export (relative to the workspace root).
  web: 'apps/client/dist',
  // A folder whose file names, sorted and without extensions, are release.json's `migrations`
  // (informational); null leaves the list empty.
  migrations: null,
};

function fail(message) {
  console.error(`release build: ${message}`);
  process.exit(1);
}

const { values: args } = parseArgs({
  options: {
    out: { type: 'string' },
    commit: { type: 'string' },
    config: { type: 'string' },
    'built-at': { type: 'string' },
    'keep-staging': { type: 'boolean', default: false },
  },
});
if (!args.out) {
  console.error(
    'usage: node scripts/release/build.mjs --out <dir> [--commit <sha>] [--config <file.json>] [--built-at <ISO>] [--keep-staging]',
  );
  process.exit(2);
}

const workspace = process.cwd();
const config = {
  ...DEFAULTS,
  ...(args.config ? JSON.parse(readFileSync(args.config, 'utf8')) : {}),
};
const commit =
  args.commit ??
  execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (!/^[0-9a-f]{40}$/.test(commit))
  fail(`--commit must be a 40-character lowercase hex commit; got ${commit}`);

// Build time: given, or SOURCE_DATE_EPOCH, or the commit's own time, so a rebuild of the same
// commit writes the same release.json and archive timestamps.
function buildTime() {
  if (args['built-at']) return new Date(args['built-at']);
  if (process.env.SOURCE_DATE_EPOCH)
    return new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000);
  const result = spawnSync('git', ['show', '-s', '--format=%ct', commit], {
    encoding: 'utf8',
  });
  const seconds = Number(String(result.stdout).trim());
  return result.status === 0 && seconds > 0
    ? new Date(seconds * 1000)
    : new Date();
}
const builtAt = buildTime();
if (Number.isNaN(builtAt.getTime())) fail('the build time is not a valid time');

const out = resolve(args.out);
const tarName = `release-${commit}.tar`;
const tarPath = join(out, tarName);
const staging = join(out, `.staging-${commit}`);
mkdirSync(out, { recursive: true });
// A release that already exists is never overwritten.
if (existsSync(tarPath)) fail(`${tarPath} already exists`);
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging);

/** The script a program runs: the first argument after `node` that is not an option. */
function scriptOf(exec) {
  return exec.slice(1).find((a) => !a.startsWith('-'));
}

function requireFile(path, hint) {
  if (!existsSync(path) || !lstatSync(path).isFile())
    fail(`expected build output ${path} is missing; ${hint}`);
}

const names = Object.keys(config.programs).sort();
if (names.join(',') !== [...V2_PROGRAMS].sort().join(','))
  fail(
    `the release must have exactly the programs ${V2_PROGRAMS.join(', ')} (the server has units for those); the config names ${names.join(', ')}`,
  );

const programs = {};
for (const name of V2_PROGRAMS) {
  const program = config.programs[name];
  const dest = join(staging, name);
  if (program.from) {
    const from = resolve(workspace, program.from);
    if (!existsSync(from)) fail(`programs.${name}.from ${from} does not exist`);
    cpSync(from, dest, { recursive: true, verbatimSymlinks: true });
  } else {
    if (!program.package) fail(`programs.${name} names no package and no from`);
    console.error(`release build: pnpm deploy ${program.package} → ${name}/`);
    const deploy = spawnSync(
      'pnpm',
      ['--filter', program.package, 'deploy', '--prod', '--legacy', dest],
      { cwd: workspace, stdio: ['ignore', 'inherit', 'inherit'] },
    );
    if (deploy.status !== 0)
      fail(`pnpm deploy of ${program.package} failed (exit ${deploy.status})`);
  }
  requireFile(
    join(dest, 'package.json'),
    `${name}/ must be a deployed package`,
  );
  const script = scriptOf(program.exec ?? []);
  if (!script) fail(`programs.${name}.exec names no script`);
  requireFile(
    join(dest, script),
    `build ${program.package ?? name} first (e.g. nest build) and make sure its package.json "files" includes ${script.split('/')[0]}/`,
  );
  programs[name] = { cwd: name, exec: program.exec };
}

const migrateProgram = config.migrate.program;
if (!V2_PROGRAMS.includes(migrateProgram))
  fail(`migrate.program must be one of ${V2_PROGRAMS.join(', ')}`);
const migrateScript = scriptOf(config.migrate.exec ?? []);
if (!migrateScript) fail('migrate.exec names no script');
requireFile(
  join(staging, migrateProgram, migrateScript),
  `the ${migrateProgram} package must build its migrate entry point`,
);

const webFrom = resolve(workspace, config.web);
requireFile(
  join(webFrom, 'index.html'),
  'run `expo export --platform web` for the client first',
);
cpSync(webFrom, join(staging, 'web'), { recursive: true, verbatimSymlinks: true });

let migrations = [];
if (config.migrations) {
  const folder = resolve(workspace, config.migrations);
  if (!existsSync(folder)) fail(`migrations folder ${folder} does not exist`);
  migrations = [
    ...new Set(
      readdirSync(folder, { withFileTypes: true })
        .filter((e) => e.isFile() && !e.name.startsWith('.'))
        .map((e) => e.name.replace(/\.(sql|ts|js|mjs|cjs)$/, '')),
    ),
  ].sort();
} else
  console.error(
    'release build: no migrations folder configured; release.json lists no migrations',
  );

const manifest = {
  schema: V2_SCHEMA,
  commit,
  builtAt: builtAt.toISOString(),
  node: process.version,
  programs,
  migrate: { cwd: migrateProgram, exec: config.migrate.exec },
  web: 'web',
  migrations,
};
const checked = validateV2Manifest(manifest, commit);
if (!checked.ok) fail(checked.reason);
writeFileSync(
  join(staging, 'release.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

// files.sha256: every file, sorted, in sha256sum's format; then checked as the server checks it.
let files;
try {
  files = hashTree(staging);
} catch (error) {
  fail(error.message);
}
const paths = [...files.keys()].sort();
const unsafe = paths.find((p) => !isSafeFilePath(p));
if (unsafe)
  fail(`${JSON.stringify(unsafe)} cannot be listed in files.sha256 safely`);
const listing = paths.map((p) => `${files.get(p)}  ${p}\n`).join('');
writeFileSync(join(staging, 'files.sha256'), listing);
const listed = checkFileList(listing, hashTree(staging));
if (!listed.ok) fail(listed.reason);

// The archive: sorted entries, root-owned, every timestamp the build time (GNU tar), so the same
// inputs give the same bytes.
const entries = readdirSync(staging).sort();
const gnu = gnuTar();
const tarArgs = gnu
  ? [
      '--sort=name',
      '--format=gnu',
      '--owner=0',
      '--group=0',
      '--numeric-owner',
      `--mtime=@${Math.floor(builtAt.getTime() / 1000)}`,
      '-cf',
      tarPath,
      '-C',
      staging,
      ...entries,
    ]
  : [
      '--uid',
      '0',
      '--gid',
      '0',
      '--numeric-owner',
      '--no-xattrs',
      '--no-mac-metadata',
      '--no-acls',
      '--no-fflags',
      '-cf',
      tarPath,
      '-C',
      staging,
      ...entries,
    ];
if (!gnu)
  console.error(
    'release build: GNU tar not found; the archive is valid but not byte-for-byte reproducible',
  );
const tar = spawnSync(gnu ?? 'tar', tarArgs, {
  stdio: ['ignore', 'inherit', 'inherit'],
  env: { ...process.env, COPYFILE_DISABLE: '1' },
});
if (tar.status !== 0) fail(`tar failed (exit ${tar.status})`);

const artifact = await sha256Stream(tarPath);
writeFileSync(`${tarPath}.sha256`, `${artifact}  ${tarName}\n`);
if (!args['keep-staging']) rmSync(staging, { recursive: true, force: true });

console.error(
  JSON.stringify({
    event: 'release-built',
    commit,
    tar: tarPath,
    files: listed.value,
    migrations: migrations.length,
    builtAt: manifest.builtAt,
    node: manifest.node,
    reproducible: Boolean(gnu),
  }),
);
console.log(artifact);
