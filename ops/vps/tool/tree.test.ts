/**
 * #228 review (M2, m2, m6): reading real release folders and archives the way `ks deploy`, the
 * release builder and the CI smoke test do (tree.ts), on a real filesystem in a temporary folder:
 * links that escape (the reviewer's proof), links in web/, dangling links, special files, program
 * folders that are links, archives with special entries, and the deploy lock as /proc/locks shows
 * it under a real `flock`. Linux-only cases are skipped elsewhere.
 *
 *   node --test ops/vps/tool/tree.test.ts
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkFileList, symlinkHash } from './plan.ts';
import {
  checkTarFile,
  hashReleaseTree,
  requireRealFolder,
  sha256File,
  TreeError,
} from './tree.ts';
import * as shared from '../../../scripts/release/files.mjs';
import * as tree from './tree.ts';

const linux = process.platform === 'linux';

function release(): string {
  const root = mkdtempSync(join(tmpdir(), 'ks-tree-test-'));
  for (const dir of ['api/dist', 'api/node_modules/.pnpm/pg@8.0.0/node_modules/pg', 'worker/dist', 'web'])
    mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, 'release.json'), '{}');
  writeFileSync(join(root, 'api/dist/main.js'), 'api');
  writeFileSync(join(root, 'api/node_modules/.pnpm/pg@8.0.0/node_modules/pg/index.js'), 'pg');
  symlinkSync('.pnpm/pg@8.0.0/node_modules/pg', join(root, 'api/node_modules/pg'));
  writeFileSync(join(root, 'worker/dist/main.js'), 'worker');
  writeFileSync(join(root, 'web/index.html'), '<!doctype html>');
  return root;
}

function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof TreeError, `expected a TreeError, got ${String(error)}`);
    return (error as Error).message;
  }
  assert.fail('expected a refusal');
}

test('#228 the release builder and smoke test use the server tool\'s own tree reader', () => {
  assert.equal(shared.hashReleaseTree, tree.hashReleaseTree);
  assert.equal(shared.checkTarFile, tree.checkTarFile);
  assert.equal(shared.requireRealFolder, tree.requireRealFolder);
  assert.equal(shared.TreeError, tree.TreeError);
});

test('#228 M2: files and links are listed; a retargeted link no longer matches files.sha256', () => {
  const root = release();
  try {
    const entries = hashReleaseTree(root, 'refuse');
    assert.equal(entries.get('api/dist/main.js'), sha256File(join(root, 'api/dist/main.js')));
    assert.equal(entries.get('api/node_modules/pg'), symlinkHash('.pnpm/pg@8.0.0/node_modules/pg'));
    const listing = [...entries].map(([p, h]) => `${h}  ${p}\n`).join('');
    assert.equal(checkFileList(listing, entries).ok, true);
    rmSync(join(root, 'api/node_modules/pg'));
    symlinkSync('.pnpm/pg@8.0.0', join(root, 'api/node_modules/pg'));
    const after = checkFileList(listing, hashReleaseTree(root, 'refuse'));
    assert.equal(after.ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('#228 M2: the reviewer\'s escape (s -> ., then s/s/s/s/../../../../etc) is refused', () => {
  const root = release();
  try {
    symlinkSync('.', join(root, 's'));
    symlinkSync('../s/s/s/s/../../../../etc', join(root, 'api/escape'));
    assert.match(refusal(() => hashReleaseTree(root, 'refuse')), /api\/escape/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('#228 M2: any link under web/ is refused, even one that stays inside', () => {
  const root = release();
  try {
    symlinkSync('index.html', join(root, 'web/home.html'));
    assert.match(refusal(() => hashReleaseTree(root, 'refuse')), /web\/home\.html.*web\//);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('#228 M2: dangling and absolute links are refused', () => {
  const root = release();
  try {
    symlinkSync('nothing-here', join(root, 'api/dangling'));
    assert.match(refusal(() => hashReleaseTree(root, 'refuse')), /points at nothing/);
    rmSync(join(root, 'api/dangling'));
    symlinkSync('/etc', join(root, 'api/absolute'));
    assert.match(refusal(() => hashReleaseTree(root, 'refuse')), /absolute/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('#228 M2: a FIFO in a release is refused', { skip: spawnSync('mkfifo', ['--help']).error !== undefined }, () => {
  const root = release();
  try {
    assert.equal(spawnSync('mkfifo', [join(root, 'api/pipe')]).status, 0);
    assert.match(refusal(() => hashReleaseTree(root, 'refuse')), /not a file, a folder or a link/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('#228 M2: a program folder (or a folder on the way to it) must be a real folder', () => {
  const root = release();
  try {
    requireRealFolder(root, 'api');
    requireRealFolder(root, 'api/dist');
    mkdirSync(join(root, 'elsewhere'));
    symlinkSync('elsewhere', join(root, 'linked'));
    assert.match(refusal(() => requireRealFolder(root, 'linked')), /real folder/);
    assert.match(refusal(() => requireRealFolder(root, 'linked/x')), /real folder|no linked/);
    assert.match(refusal(() => requireRealFolder(root, 'missing')), /no missing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('#228 a received release may not carry .ks/; a verified one keeps the server\'s .ks/ out of the list', () => {
  const root = release();
  try {
    mkdirSync(join(root, '.ks'));
    writeFileSync(join(root, '.ks/release.env'), 'KS_COMMIT=x\n');
    assert.match(refusal(() => hashReleaseTree(root, 'refuse')), /\.ks/);
    assert.equal(hashReleaseTree(root, 'skip').has('.ks/release.env'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('#228 m6: archives are checked from their listing before anything is extracted', { skip: !linux }, () => {
  const root = release();
  const out = mkdtempSync(join(tmpdir(), 'ks-tar-test-'));
  try {
    const good = join(out, 'good.tar');
    const made = spawnSync('tar', ['-cf', good, '-C', root, 'release.json', 'api', 'worker', 'web']);
    assert.equal(made.status, 0, String(made.stderr));
    assert.ok(checkTarFile(good) > 0);
    // A FIFO in the archive is refused before extraction.
    assert.equal(spawnSync('mkfifo', [join(root, 'web/pipe')]).status, 0);
    const fifo = join(out, 'fifo.tar');
    assert.equal(spawnSync('tar', ['-cf', fifo, '-C', root, 'web']).status, 0);
    assert.match(refusal(() => checkTarFile(fifo)), /not a file, a folder or a link/);
    // Absolute names are refused (GNU tar keeps them with -P).
    const absolute = join(out, 'absolute.tar');
    assert.equal(spawnSync('tar', ['-P', '-cf', absolute, join(root, 'release.json')]).status, 0);
    assert.match(refusal(() => checkTarFile(absolute)), /unsafe path/);
    // A long path (GNU long-name entries) is read whole.
    const deep = join(root, 'api', 'd'.repeat(90), 'e'.repeat(90));
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, 'index.js'), 'x');
    const long = join(out, 'long.tar');
    assert.equal(spawnSync('tar', ['--format=gnu', '-cf', long, '-C', root, 'api']).status, 0);
    assert.ok(checkTarFile(long) > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test('#228 m2: under a real flock, /proc/locks shows the lock held by ks\'s parent', {
  skip: !linux || spawnSync('flock', ['--version']).status !== 0,
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'ks-lock-test-'));
  try {
    const lock = join(dir, 'deploy.lock');
    writeFileSync(lock, '');
    const plan = new URL('./plan.ts', import.meta.url).href;
    const script = `
      import { readFileSync, statSync } from 'node:fs';
      const { deployLockHeldByParent } = await import(${JSON.stringify(plan)});
      const held = deployLockHeldByParent(readFileSync('/proc/locks', 'utf8'), statSync(${JSON.stringify(lock)}).ino, process.ppid);
      process.stdout.write(held ? 'held' : 'not held');
    `;
    const under = spawnSync('flock', [lock, process.execPath, '--input-type=module', '-e', script], {
      encoding: 'utf8',
    });
    assert.equal(under.stdout, 'held', String(under.stderr));
    const without = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
    });
    assert.equal(without.stdout, 'not held', String(without.stderr));
    assert.ok(statSync(lock).isFile());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
