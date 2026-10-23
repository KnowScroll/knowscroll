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
import { spawnSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, openSync, closeSync, readFileSync, existsSync } from 'node:fs';
import {
  DeploymentControl,
  kernelFlockHeld,
  lockIdentity,
  processStartTicks,
  receiveDeploymentFifo,
} from './system.ts';
import { type DeploymentIntent, type DeploymentIdentity } from './plan.ts';
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkFileList, symlinkHash } from './plan.ts';
import { checkTarFile, hashReleaseTree, requireRealFolder, sha256File, TreeError } from './tree.ts';
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

function controlFixture(root: string) {
  const control = new DeploymentControl(root, process.getuid!());
  const id = '11111111-1111-4111-8111-111111111111';
  const request = {
    version: 'ks-deploy-request.v1' as const,
    requestId: id,
    world: 'dev' as const,
    mode: 'deploy' as const,
    commit: 'a'.repeat(40),
  };
  const identity: DeploymentIdentity = {
    bootId: '33333333-3333-4333-8333-333333333333',
    unit: `ks-deploy@${id}.service`,
    pid: 123,
    startTicks: '456',
    cgroup: `/system.slice/ks-deploy@${id}.service`,
    device: '8:1',
    inode: '42',
    toolSha256: '1'.repeat(64),
    unitSha256: '2'.repeat(64),
  };
  const intent: DeploymentIntent = {
    ...request,
    ...identity,
    intentVersion: 'ks-deploy-intent.v1',
    nonce: '22222222-2222-4222-8222-222222222222',
    artifactSha256: createHash('sha256').update('tar').digest('hex'),
    artifactBytes: 3,
    repository: 'KnowScroll/knowscroll',
    workflowRunId: 10,
    workflowRunAttempt: 1,
    workflowSha256: '4'.repeat(64),
    pushHead: request.commit,
    proofSha256: '5'.repeat(64),
    reviewSha256: '6'.repeat(64),
    expectedCurrent: null,
    expectedPrevious: null,
    notBeforeUtc: '2026-10-23T00:00:00.000Z',
    expiresUtc: '2026-10-23T00:00:01.000Z',
    notBeforeMono: 100,
    expiresMono: 1100,
  };
  return { control, request, identity, intent };
}
test(
  '#250 actual private control FD refuses malformed/symlink/oversized data; consume once only after exact proof',
  { skip: !linux },
  () => {
    const root = mkdtempSync(join(tmpdir(), 'ks-admission-'));
    const { control: c, request: r, identity, intent: i } = controlFixture(root);
    try {
      assert.throws(() => c.consume(r, identity, Date.parse(i.notBeforeUtc), 100));
      c.exclusive('intent.json', i);
      for (const k of Object.keys(identity))
        assert.throws(() => c.consume(r, { ...identity, [k]: 'wrong' }, Date.parse(i.notBeforeUtc), 100));
      assert.equal(existsSync(join(root, 'consumed.json')), false, 'wrong waiter never consumes permit');
      assert.throws(() => c.consume({ ...r, world: 'stage' }, identity, Date.parse(i.notBeforeUtc), 100));
      assert.throws(() => c.consume(r, identity, Date.parse(i.expiresUtc), 100));
      assert.throws(() => c.consume(r, identity, Date.parse(i.notBeforeUtc), 1100));
      assert.equal(c.consume(r, identity, Date.parse(i.notBeforeUtc), 100).nonce, i.nonce);
      const second = new DeploymentControl(root, process.getuid!());
      try {
        assert.throws(() => second.consume(r, identity, Date.parse(i.notBeforeUtc), 100), 'real O_EXCL nonce barrier');
      } finally {
        second.close();
      }
      assert.deepEqual(JSON.parse(readFileSync(join(root, 'consumed.json'), 'utf8')), {requestId:r.requestId,nonce:i.nonce,phase:'consumed_preparing'});
      // A restart after consumed but before DDL keeps the same irreversible tombstone.
      assert.equal(existsSync(join(root, 'ddl-may-start.json')), false);
      c.exclusive('large.json', 'x'.repeat(5000));
      assert.throws(() => c.read('large.json', 4096));
      writeFileSync(join(root, 'malformed.json'), '{', { mode: 0o600 });
      assert.throws(() => c.read('malformed.json', 4096));
      symlinkSync('intent.json', join(root, 'alias.json'));
      assert.throws(() => c.read('alias.json', 8192));
      assert.throws(() => c.path('../escape'));
      assert.throws(() => c.exclusive('intent.json', i));
    } finally {
      c.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
test(
  '#250 real FIFO receive binds exact hash/size and deadline before any deployment effects',
  { skip: !linux },
  async () => {
    for (const scenario of ['good', 'overflow', 'short', 'hash', 'expired'] as const) {
      const root = mkdtempSync(join(tmpdir(), 'ks-fifo-'));
      const { control: c, intent } = controlFixture(root);
      const pipe = join(root, 'incoming');
      assert.equal(spawnSync('/usr/bin/mkfifo', ['-m', '600', pipe]).status, 0);
      const fd = openSync(pipe, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
      const out = openSync(join(root, 'archive'), constants.O_RDWR | constants.O_CREAT | constants.O_EXCL, 0o600);
      const bytes = scenario === 'overflow' ? 'tars' : scenario === 'short' ? 'ta' : 'tar';
      // Real separate writer; no product/provider/DB fixtures or mocked successful storage.
      const writer = spawn(
        process.execPath,
        ['-e', `require('node:fs').writeFileSync(process.argv[1],process.argv[2])`, pipe, bytes],
        { stdio: 'ignore' },
      );
      try {
        const operation = receiveDeploymentFifo(
          fd,
          out,
          { ...intent, artifactSha256: scenario === 'hash' ? 'f'.repeat(64) : intent.artifactSha256 },
          () => scenario !== 'expired',
        );
        if (scenario === 'good') {
          await operation;
          assert.equal(readFileSync(join(root, 'archive'), 'utf8'), 'tar');
        } else await assert.rejects(operation);
      } finally {
        writer.kill();
        await new Promise<void>((resolve) => {
          if (writer.exitCode !== null || writer.signalCode !== null) resolve();
          else writer.once('exit', () => resolve());
        });
        closeSync(fd);
        closeSync(out);
        c.close();
        rmSync(root, { recursive: true, force: true });
      }
    }
  },
);
async function untilFile(path: string): Promise<void> {
  const end = Date.now() + 5000;
  while (!existsSync(path)) {
    if (Date.now() >= end) assert.fail('fixture deadline');
    await new Promise((r) => setTimeout(r, 10));
  }
}
test('#250 actual detached operation keeps real flock/status after its transport dies', { skip: !linux }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'ks-lifetime-'));
  const lock = join(root, 'lock');
  writeFileSync(lock, '', { mode: 0o600 });
  const module = new URL('./system.ts', import.meta.url).href;
  const script = `import{DeploymentControl,kernelFlockHeld,lockIdentity,processStartTicks}from${JSON.stringify(module)};
    import*as fs from'node:fs';const root=process.argv[1];const c=new DeploymentControl(root,process.getuid());
    const st=fs.statSync(root+'/lock',{bigint:true});const proof=lockIdentity(st.dev,st.ino);
    if(!kernelFlockHeld(fs.readFileSync('/proc/locks','utf8'),process.ppid,proof))process.exit(2);
    c.exclusive('ddl-marker',{pid:process.ppid,start:processStartTicks(fs.readFileSync('/proc/'+process.ppid+'/stat','utf8'))});
    await new Promise(r=>setTimeout(r,500));
    if(!kernelFlockHeld(fs.readFileSync('/proc/locks','utf8'),process.ppid,proof))process.exit(3);
    c.exclusive('finished',{phase:'succeeded'});c.close();`;
  // The fixture models systemd's independent process lifetime; it does not certify an installed unit/cgroup.
  const transportCode = `const{spawn}=require('node:child_process');const fs=require('node:fs');
    const p=spawn('/usr/bin/flock',[process.argv[1],process.execPath,'--input-type=module','-e',process.argv[2],process.argv[3]],{detached:true,stdio:'ignore'});
    p.unref();fs.writeFileSync(process.argv[3]+'/child-pid',String(p.pid));setInterval(()=>{},1000);`;
  const transport = spawn(process.execPath, ['-e', transportCode, lock, script, root], { stdio: 'ignore' });
  let child: number | undefined;
  try {
    await untilFile(join(root, 'child-pid'));
    child = Number(readFileSync(join(root, 'child-pid'), 'utf8'));
    await untilFile(join(root, 'ddl-marker'));
    transport.kill();
    const st = statSync(lock, { bigint: true });
    assert.equal(kernelFlockHeld(readFileSync('/proc/locks', 'utf8'), child, lockIdentity(st.dev, st.ino)), true);
    assert.equal(
      spawnSync('/usr/bin/flock', ['-n', lock, 'true']).status,
      1,
      'transport death does not release operation lock',
    );
    await untilFile(join(root, 'finished'));
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'finished'), 'utf8')), { phase: 'succeeded' });
    assert.ok(processStartTicks(readFileSync('/proc/self/stat', 'utf8')));
    assert.equal(
      kernelFlockHeld('', child, lockIdentity(st.dev, st.ino)),
      false,
      'forged SUDO_COMMAND is not kernel proof',
    );
  } finally {
    transport.kill();
    if (child !== undefined) {
      try {
        process.kill(-child, 'SIGKILL');
      } catch {
        /* Already terminal. */
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});
