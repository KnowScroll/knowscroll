/**
 * The server tool's actions (#201): unpack and verify releases, migrate as the world's own user,
 * switch the `current` link, restart and health-check a world, roll back, clean up, and guard the
 * disk. Decisions come from plan.ts. Runs as root on the server through `ks` (ks.ts); every step
 * either completes or leaves the previous state in place, and says which on stderr.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  BRANCH_OF,
  cutroomSwitchDecision,
  diskGuardDecision,
  parseEnvFile,
  releasesToDelete,
  validateDeployRequest,
  validateRunRequest,
  type World,
} from './plan.ts';

const ROOT = '/srv/knowscroll';
const RELEASES = `${ROOT}/releases`;
const RUN = '/run/knowscroll';
const DISK_FLAG = `${RUN}/disk-critical`;
const REPOSITORY = 'https://github.com/KnowScroll/knowscroll';
const KEEP_UNUSED_RELEASES = 3;
// #199: the shared Reel pool (its own database) and the shared Cutroom (`ks-cutroom@pool`).
const POOL_ENV = '/etc/knowscroll/pool.env';
const CUTROOM_CODE = `${ROOT}/cutroom`;
const CUTROOM_DATA = `${ROOT}/cutroom-pool`;
const CUTROOM_UNIT = 'ks-cutroom@pool.service';
const CUTROOM_PNPM = 'pnpm@10.15.1';
const HEALTH_TIMEOUT_MS = 90_000;
// Services the disk guard may pause under pressure; absent ones are skipped.
const PAUSABLE = [
  'ks-generation@dev.service',
  'ks-generation@stage.service',
  'ks-cutroom@pool.service',
];

export class Refusal extends Error {}

function say(event: Record<string, unknown>): void {
  process.stderr.write(
    `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`,
  );
}

function provisioned(world: World): boolean {
  return existsSync(`/etc/knowscroll/${world}.env`);
}

function worldEnv(world: World): Record<string, string> {
  return parseEnvFile(readFileSync(`/etc/knowscroll/${world}.env`, 'utf8'));
}

function serviceUser(world: World): { uid: number; gid: number } {
  const line = readFileSync('/etc/passwd', 'utf8')
    .split('\n')
    .find((l) => l.startsWith(`ks-${world}:`));
  if (!line) throw new Refusal(`no service user ks-${world}`);
  const [, , uid, gid] = line.split(':');
  return { uid: Number(uid), gid: Number(gid) };
}

function linkTarget(path: string): string | null {
  try {
    return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : null;
  } catch {
    return null;
  }
}

function commitOf(target: string | null): string | null {
  const match = target ? /\/releases\/([0-9a-f]{40})$/.exec(target) : null;
  return match ? (match[1] as string) : null;
}

/** Points `link` at `target` atomically (a new link renamed over the old one). */
function relink(link: string, target: string): void {
  const temp = `${link}.next`;
  rmSync(temp, { force: true });
  symlinkSync(target, temp);
  renameSync(temp, link);
}

function branchTip(world: World): string | null {
  const out = execFileSync(
    'git',
    ['ls-remote', REPOSITORY, `refs/heads/${BRANCH_OF[world]}`],
    { encoding: 'utf8', timeout: 30_000 },
  );
  return out.split(/\s+/)[0] || null;
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function hasRelease(commit: string): boolean {
  return existsSync(join(RELEASES, commit, 'release.json'));
}

/** Unpacks a release tarball from stdin and verifies it names `commit` and its bundles match. */
function receiveRelease(commit: string): void {
  if (hasRelease(commit)) {
    say({ event: 'release-already-present', commit });
    // Drain stdin so the sender is not left writing into a closed pipe.
    spawnSync('cat', [], { stdio: ['inherit', 'ignore', 'inherit'] });
    return;
  }
  const incoming = join(RELEASES, `.incoming-${commit}-${process.pid}`);
  mkdirSync(incoming, { recursive: true });
  try {
    const tar = spawnSync('tar', ['-x', '-C', incoming], {
      stdio: ['inherit', 'inherit', 'inherit'],
    });
    if (tar.status !== 0)
      throw new Refusal('the release tarball did not unpack');
    const manifest = JSON.parse(
      readFileSync(join(incoming, 'release.json'), 'utf8'),
    ) as {
      commit: string;
      bundles: Record<string, string>;
    };
    if (manifest.commit !== commit)
      throw new Refusal(`the release is for ${manifest.commit}, not ${commit}`);
    for (const [file, digest] of Object.entries(manifest.bundles))
      if (sha256(join(incoming, file)) !== digest)
        throw new Refusal(`${file} does not match its recorded hash`);
    execFileSync('chmod', ['-R', 'a+rX,go-w', incoming]);
    renameSync(incoming, join(RELEASES, commit));
    say({ event: 'release-received', commit });
  } finally {
    rmSync(incoming, { recursive: true, force: true });
  }
}

function systemUser(name: string): { uid: number; gid: number } {
  const line = readFileSync('/etc/passwd', 'utf8')
    .split('\n')
    .find((l) => l.startsWith(`${name}:`));
  if (!line) throw new Refusal(`no system user ${name}`);
  const [, , uid, gid] = line.split(':');
  return { uid: Number(uid), gid: Number(gid) };
}

/** #199: applies the shared pool's own migrations, as Postgres acting for the pool's owner role.
 * Runs before every world's migrations; a pool migration must work with older world code too. */
function migratePool(release: string): void {
  // A release from before #199 has no pool migrations; it deploys exactly as it did then.
  if (
    !existsSync(POOL_ENV) ||
    !existsSync(join(release, 'dist/migrate-pool.mjs'))
  )
    return;
  const url = parseEnvFile(readFileSync(POOL_ENV, 'utf8')).KS_POOL_MIGRATE_URL;
  if (!url) throw new Refusal(`${POOL_ENV} names no KS_POOL_MIGRATE_URL`);
  const result = spawnSync(
    'node',
    ['--enable-source-maps', 'dist/migrate-pool.mjs'],
    {
      cwd: release,
      env: { PATH: '/usr/bin:/bin', KS_POOL_DATABASE_URL: url },
      ...systemUser('postgres'),
      stdio: ['ignore', 'inherit', 'inherit'],
      timeout: 5 * 60_000,
    },
  );
  if (result.status !== 0)
    throw new Refusal(
      `the shared pool's migrations failed (exit ${result.status})`,
    );
}

/** Open (claimed, not yet settled) paid orders in the shared pool, or null if it can't be read. */
function openPoolOrders(): number | null {
  if (!existsSync(POOL_ENV)) return 0;
  const result = spawnSync(
    'psql',
    [
      '-X',
      '-A',
      '-t',
      '-d',
      'knowscroll_pool',
      '-c',
      "SELECT count(*) FROM pool_order WHERE state = 'claimed'",
    ],
    {
      env: { PATH: '/usr/bin:/bin' },
      ...systemUser('postgres'),
      encoding: 'utf8',
      timeout: 15_000,
    },
  );
  const count = Number(String(result.stdout).trim());
  return result.status === 0 && Number.isInteger(count) ? count : null;
}

function runAsWorld(world: World, release: string, program: string): void {
  const result = spawnSync(
    'node',
    ['--enable-source-maps', `dist/${program}.mjs`],
    {
      cwd: release,
      env: {
        PATH: '/usr/bin:/bin',
        ...worldEnv(world),
        NODE_ENV: 'production',
        KS_WORLD: world,
      },
      ...serviceUser(world),
      stdio: ['ignore', 'inherit', 'inherit'],
      timeout: 10 * 60_000,
    },
  );
  if (result.status !== 0)
    throw new Refusal(`${program} failed for ${world} (exit ${result.status})`);
}

function systemctl(...args: string[]): void {
  execFileSync('systemctl', args, { stdio: ['ignore', 'inherit', 'inherit'] });
}

async function healthy(world: World, commit: string): Promise<boolean> {
  const port = worldEnv(world).PORT;
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const body = (await res.json()) as { commit?: string; world?: string };
        if (body.commit === commit && body.world === world) return true;
      }
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function startWorld(world: World, commit: string): Promise<boolean> {
  systemctl('enable', `ks-world@${world}.target`);
  systemctl('restart', `ks-world@${world}.target`);
  return healthy(world, commit);
}

export async function deploy(
  world: string,
  commit: string,
  source: 'stdin' | 'existing',
): Promise<void> {
  if (existsSync(DISK_FLAG))
    throw new Refusal('the disk is critically full; deploys are paused');
  const tip = world === 'dev' ? null : branchTip(world as World);
  const request = validateDeployRequest(world, commit, { tip });
  if (!request.ok) throw new Refusal(request.reason);
  const w = request.world;
  if (!provisioned(w))
    throw new Refusal(`${w} is not set up on this server yet`);

  if (source === 'stdin') receiveRelease(commit);
  else if (!hasRelease(commit))
    throw new Refusal(`no release ${commit} on this server to reuse`);

  const release = join(RELEASES, commit);
  const worldRoot = join(ROOT, w);
  const before = linkTarget(join(worldRoot, 'current'));
  say({ event: 'deploy-start', world: w, commit, from: commitOf(before) });

  migratePool(release);
  runAsWorld(w, release, 'migrate');
  if (w !== 'live') runAsWorld(w, release, 'seed');

  if (before && commitOf(before) !== commit)
    relink(join(worldRoot, 'previous'), before);
  relink(join(worldRoot, 'current'), release);

  if (await startWorld(w, commit)) {
    appendFileSync(
      join(worldRoot, 'releases.log'),
      `${JSON.stringify({ at: new Date().toISOString(), commit, result: 'deployed', from: commitOf(before) })}\n`,
    );
    say({ event: 'deploy-healthy', world: w, commit });
    cleanup(false);
    return;
  }

  say({ event: 'deploy-unhealthy', world: w, commit });
  if (before) {
    relink(join(worldRoot, 'current'), before);
    const back = commitOf(before);
    // Before a world's first good release there is nothing to run: stop it, show the placeholder.
    if (!back) systemctl('stop', `ks-world@${w}.target`);
    const restored = back ? await startWorld(w, back) : false;
    say({ event: 'rolled-back', world: w, to: back, healthy: restored });
  }
  appendFileSync(
    join(worldRoot, 'releases.log'),
    `${JSON.stringify({ at: new Date().toISOString(), commit, result: 'failed-and-rolled-back' })}\n`,
  );
  throw new Refusal(
    `${commit} did not become healthy on ${w}; the previous release is back`,
  );
}

export async function rollback(world: string): Promise<void> {
  const w = world as World;
  if (!provisioned(w))
    throw new Refusal(`${world} is not set up on this server`);
  const worldRoot = join(ROOT, w);
  const previous = linkTarget(join(worldRoot, 'previous'));
  const current = linkTarget(join(worldRoot, 'current'));
  const back = commitOf(previous);
  if (!previous || !back)
    throw new Refusal(`${w} has no previous release to return to`);
  relink(join(worldRoot, 'current'), previous);
  if (current) relink(join(worldRoot, 'previous'), current);
  if (!(await startWorld(w, back)))
    throw new Refusal(`${back} is not healthy on ${w} either`);
  say({ event: 'rolled-back', world: w, to: back });
}

function inUseReleases(): Set<string> {
  const inUse = new Set<string>();
  for (const world of ['live', 'stage', 'dev'] as const)
    for (const name of ['current', 'previous']) {
      const commit = commitOf(linkTarget(join(ROOT, world, name)));
      if (commit) inUse.add(commit);
    }
  return inUse;
}

function olderThan(path: string, ms: number): boolean {
  return Date.now() - statSync(path).mtimeMs > ms;
}

export function cleanup(emergency: boolean): void {
  const DAY = 86_400_000;
  const releases = readdirSync(RELEASES)
    .filter((name) => /^[0-9a-f]{40}$/.test(name))
    .map((commit) => ({
      commit,
      mtimeMs: statSync(join(RELEASES, commit)).mtimeMs,
    }));
  const doomed = releasesToDelete(
    releases,
    inUseReleases(),
    emergency ? 2 : KEEP_UNUSED_RELEASES,
  );
  for (const commit of doomed)
    rmSync(join(RELEASES, commit), { recursive: true, force: true });

  // Interrupted uploads and media imports leave temp files; a day later nobody is coming back.
  let temps = 0;
  for (const name of readdirSync(RELEASES))
    if (name.startsWith('.incoming-') && olderThan(join(RELEASES, name), DAY)) {
      rmSync(join(RELEASES, name), { recursive: true, force: true });
      temps++;
    }
  for (const world of ['live', 'stage', 'dev'] as const) {
    const tmp = join(ROOT, world, 'media', 'tmp');
    if (!existsSync(tmp)) continue;
    for (const name of readdirSync(tmp))
      if (name.endsWith('.tmp') && olderThan(join(tmp, name), DAY)) {
        unlinkSync(join(tmp, name));
        temps++;
      }
  }

  if (emergency)
    execFileSync('journalctl', ['--vacuum-size=500M'], {
      stdio: ['ignore', 'ignore', 'inherit'],
    });
  say({
    event: 'cleanup',
    emergency,
    releasesDeleted: doomed,
    tempFilesDeleted: temps,
  });
}

function usedPercent(): number {
  const s = statfsSync('/');
  const used = s.blocks - s.bfree;
  return (100 * used) / (used + s.bavail);
}

function active(unit: string): boolean {
  return spawnSync('systemctl', ['is-active', '--quiet', unit]).status === 0;
}

export function diskGuard(): void {
  mkdirSync(RUN, { recursive: true });
  const used = usedPercent();
  const decision = diskGuardDecision(used, existsSync(DISK_FLAG));
  const percent = Math.round(used * 10) / 10;
  if (decision === 'fine') return;
  if (decision === 'warn')
    return say({ event: 'disk-warning', usedPercent: percent });
  if (decision === 'still-critical') {
    say({ event: 'disk-still-critical', usedPercent: percent });
    return cleanup(true);
  }
  if (decision === 'critical') {
    const paused = PAUSABLE.filter(active);
    writeFileSync(
      DISK_FLAG,
      `${JSON.stringify({ since: new Date().toISOString(), paused })}\n`,
    );
    for (const unit of paused) systemctl('stop', unit);
    say({ event: 'disk-critical', usedPercent: percent, paused });
    return cleanup(true);
  }
  const { paused } = JSON.parse(readFileSync(DISK_FLAG, 'utf8')) as {
    paused: string[];
  };
  unlinkSync(DISK_FLAG);
  for (const unit of paused) systemctl('start', unit);
  say({ event: 'disk-recovered', usedPercent: percent, resumed: paused });
}

/** #199: starts one operator program from a world's current release, as the world's own user
 * with the world's settings; arguments go straight to the program, never through a shell. */
export function runProgram(
  world: string,
  program: string,
  args: readonly string[],
): number {
  const request = validateRunRequest(world, program);
  if (!request.ok) throw new Refusal(request.reason);
  const w = request.world;
  if (!provisioned(w)) throw new Refusal(`${w} is not set up on this server`);
  const release = commitOf(linkTarget(join(ROOT, w, 'current')));
  if (!release) throw new Refusal(`${w} has no deployed release to run`);
  const result = spawnSync(
    'node',
    ['--enable-source-maps', `dist/${request.program}.mjs`, ...args],
    {
      cwd: join(RELEASES, release),
      env: {
        PATH: '/usr/bin:/bin',
        ...worldEnv(w),
        NODE_ENV: 'production',
        KS_WORLD: w,
      },
      ...serviceUser(w),
      stdio: ['ignore', 'inherit', 'inherit'],
      timeout: 30 * 60_000,
    },
  );
  return result.status ?? 1;
}

function cutroomCurrent(): string | null {
  const target = linkTarget(join(CUTROOM_CODE, 'current'));
  const match = target ? /\/releases\/([0-9a-f]{40})$/.exec(target) : null;
  return match ? (match[1] as string) : null;
}

/** #199: restarts the shared Cutroom, but never while a paid order is open in the pool. */
export function cutroomRestart(): void {
  const decision = cutroomSwitchDecision(openPoolOrders());
  if (!decision.ok) throw new Refusal(decision.reason);
  if (!cutroomCurrent()) throw new Refusal('no Cutroom version is installed');
  systemctl('enable', CUTROOM_UNIT);
  systemctl('restart', CUTROOM_UNIT);
  say({ event: 'cutroom-restarted', revision: cutroomCurrent() });
}

/** #199: installs Cutroom exactly as upstream ships it, at one pinned commit: its source tree on
 * stdin (`git archive`, copied from the owner's Mac; nothing in the Cutroom repository changes),
 * then its own production dependencies. Switches to it only when no paid order is open. */
export function cutroomInstall(commit: string): void {
  if (!/^[0-9a-f]{40}$/.test(commit))
    throw new Refusal('the commit must be 40 lowercase hex characters');
  const releases = join(CUTROOM_CODE, 'releases');
  const dest = join(releases, commit);
  mkdirSync(releases, { recursive: true });
  if (existsSync(join(dest, 'CUTROOM_REVISION'))) {
    spawnSync('cat', [], { stdio: ['inherit', 'ignore', 'inherit'] });
    say({ event: 'cutroom-already-installed', commit });
  } else {
    const incoming = join(releases, `.incoming-${commit}-${process.pid}`);
    mkdirSync(incoming, { recursive: true });
    try {
      const tar = spawnSync('tar', ['-x', '-C', incoming], {
        stdio: ['inherit', 'inherit', 'inherit'],
      });
      if (tar.status !== 0)
        throw new Refusal('the Cutroom tarball did not unpack');
      if (!existsSync(join(incoming, 'apps/service/src/main.ts')))
        throw new Refusal('the tarball is not a Cutroom source tree');
      const install = spawnSync(
        'corepack',
        [CUTROOM_PNPM, 'install', '--frozen-lockfile', '--prod'],
        {
          cwd: incoming,
          env: {
            PATH: '/usr/bin:/bin',
            HOME: CUTROOM_CODE,
            COREPACK_HOME: join(CUTROOM_CODE, 'corepack'),
            COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
            npm_config_store_dir: join(CUTROOM_CODE, 'pnpm-store'),
          },
          stdio: ['ignore', 'inherit', 'inherit'],
          timeout: 20 * 60_000,
        },
      );
      if (install.status !== 0)
        throw new Refusal(
          `Cutroom's dependencies did not install (exit ${install.status})`,
        );
      writeFileSync(join(incoming, 'CUTROOM_REVISION'), `${commit}\n`);
      execFileSync('chmod', ['-R', 'a+rX,go-w', incoming]);
      renameSync(incoming, dest);
      say({ event: 'cutroom-installed', commit });
    } finally {
      rmSync(incoming, { recursive: true, force: true });
    }
  }
  if (cutroomCurrent() === commit) return;
  const decision = cutroomSwitchDecision(openPoolOrders());
  if (!decision.ok)
    throw new Refusal(`installed, but not switched: ${decision.reason}`);
  relink(join(CUTROOM_CODE, 'current'), dest);
  say({ event: 'cutroom-switched', commit });
  if (existsSync('/etc/knowscroll/cutroom-pool.env')) cutroomRestart();
}

async function cutroomStatus(): Promise<Record<string, unknown>> {
  let ready: unknown = 'down';
  try {
    const res = await fetch('http://127.0.0.1:8797/v1/ready', {
      signal: AbortSignal.timeout(3000),
    });
    ready = res.status === 200 ? 'ready' : `http ${res.status}`;
  } catch {
    // stays 'down'
  }
  const questions = join(CUTROOM_DATA, 'QUESTIONS.md');
  return {
    revision: cutroomCurrent(),
    active: active(CUTROOM_UNIT),
    ready,
    openPoolOrders: openPoolOrders(),
    // Cutroom reports cap refusals and failed re-runs only here; nobody else reads it.
    questions: existsSync(questions)
      ? readFileSync(questions, 'utf8').trim().split('\n').slice(-5)
      : [],
  };
}

export async function status(): Promise<Record<string, unknown>> {
  const worlds: Record<string, unknown> = {};
  for (const world of ['live', 'stage', 'dev'] as const) {
    if (!provisioned(world)) {
      worlds[world] = { provisioned: false };
      continue;
    }
    let health: unknown = 'down';
    try {
      const res = await fetch(
        `http://127.0.0.1:${worldEnv(world).PORT}/health`,
        {
          signal: AbortSignal.timeout(3000),
        },
      );
      health = res.ok ? await res.json() : `http ${res.status}`;
    } catch {
      // stays 'down'
    }
    const log = join(ROOT, world, 'releases.log');
    worlds[world] = {
      current: commitOf(linkTarget(join(ROOT, world, 'current'))),
      previous: commitOf(linkTarget(join(ROOT, world, 'previous'))),
      health,
      services: Object.fromEntries(
        ['api', 'worker', 'maintenance', 'generation'].map((s) => [
          s,
          active(`ks-${s}@${world}.service`),
        ]),
      ),
      lastDeploy: existsSync(log)
        ? readFileSync(log, 'utf8').trim().split('\n').pop()
        : null,
    };
  }
  return {
    disk: {
      usedPercent: Math.round(usedPercent() * 10) / 10,
      critical: existsSync(DISK_FLAG),
    },
    releases: readdirSync(RELEASES).filter((n) => /^[0-9a-f]{40}$/.test(n))
      .length,
    worlds,
    cutroom: await cutroomStatus(),
  };
}
