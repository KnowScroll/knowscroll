/**
 * The server tool's actions (#201): unpack and verify releases, migrate as the world's own user,
 * switch the `current` link, restart and health-check a world, roll back, clean up, and guard the
 * disk. Decisions come from plan.ts. Runs as root on the server through `ks` (ks.ts); every step
 * either completes or leaves the previous state in place, and says which on stderr.
 *
 * #228: two release generations. A release.json without `schema` is v1 and is handled exactly as
 * before (dist/*.mjs bundles, migrate-pool, migrate, seed, ks-world@<world>.target). A
 * `ks-release.v2` release is verified file by file against files.sha256, migrated with the
 * command its release.json names (as the world's user, with the world's v2 settings, never
 * seeded), and run by ks2-world@<world>.target; switching a world between generations stops the
 * other generation's units first, and a failed deploy restores whichever generation ran before.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
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
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  activationPlan,
  afterFailedDeploy,
  BRANCH_OF,
  checkFileList,
  cutroomSwitchDecision,
  diskGuardDecision,
  type Generation,
  generationSwitchDecision,
  healthMatches,
  isWorld,
  parseEnvFile,
  type ReleaseLink,
  releaseGeneration,
  releasesInUse,
  releasesToDelete,
  SERVER_DIR,
  type Slot,
  type V2Manifest,
  V2_PROGRAMS,
  V1_SERVICES,
  validateDeployRequest,
  validateRunRequest,
  validateV2Manifest,
  type World,
  worldUnits,
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
// #228: what Ansible (roles/worlds_v2, roles/backups) puts on the server for v2.
const V2_ENV = (world: World) => `/etc/knowscroll/${world}.v2.env`;
const V2_SECRET_ENV = (world: World) =>
  `/etc/knowscroll/secrets/v2-${world}/database.env`;
const BACKUPS = `${ROOT}/backups`;

export class Refusal extends Error {}

function say(event: Record<string, unknown>): void {
  process.stderr.write(
    `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`,
  );
}

function provisioned(world: World): boolean {
  return existsSync(`/etc/knowscroll/${world}.env`);
}

/** #228: Ansible has set the world up for v2 releases (its settings and its database secret). */
function provisionedV2(world: World): boolean {
  return existsSync(V2_ENV(world)) && existsSync(V2_SECRET_ENV(world));
}

function worldEnv(world: World): Record<string, string> {
  return parseEnvFile(readFileSync(`/etc/knowscroll/${world}.env`, 'utf8'));
}

/** #228: a world's v2 settings plus its database secret, as the v2 units get them. */
function worldEnvV2(world: World): Record<string, string> {
  return {
    ...parseEnvFile(readFileSync(V2_ENV(world), 'utf8')),
    ...parseEnvFile(readFileSync(V2_SECRET_ENV(world), 'utf8')),
  };
}

/** v1 and v2 of one world listen on the same loopback port, so Caddy's upstreams never move. */
function worldPort(world: World, generation: Generation): string | undefined {
  return generation === 'v1'
    ? worldEnv(world).PORT
    : parseEnvFile(readFileSync(V2_ENV(world), 'utf8')).PORT;
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

/** Reads a release's release.json. It must be a regular file (never a link to something else on
 * this server), and a parse error never echoes its content. */
function readManifest(dir: string): unknown {
  const path = join(dir, 'release.json');
  let text: string;
  try {
    if (!lstatSync(path).isFile()) throw new Error('not a regular file');
    text = readFileSync(path, 'utf8');
  } catch {
    throw new Refusal('the release has no readable release.json');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Refusal('the release.json is not valid JSON');
  }
}

function generationOf(dir: string): Generation {
  const generation = releaseGeneration(readManifest(dir));
  if (!generation.ok) throw new Refusal(generation.reason);
  return generation.value;
}

/** The commit and generation a `current`/`previous` link names, or null for the placeholder. A
 * release whose release.json cannot be read is taken for v1, the only generation before #228. */
function slotOf(target: string | null): Slot {
  const commit = commitOf(target);
  if (!commit) return null;
  try {
    return { commit, generation: generationOf(join(RELEASES, commit)) };
  } catch (error) {
    say({
      event: 'release-generation-unknown',
      commit,
      assumed: 'v1',
      reason: (error as Error).message,
    });
    return { commit, generation: 'v1' };
  }
}

/**
 * #228: every regular file under a v2 release with its sha256, keyed by relative path, leaving out
 * files.sha256 and the server's own .ks/ folder. Links must be relative and stay inside the
 * release; anything that is not a file, a folder or such a link is refused.
 */
function hashTree(
  root: string,
  serverDir: 'refuse' | 'skip',
): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      const abs = join(dir, entry.name);
      if (!rel && entry.name === SERVER_DIR) {
        if (serverDir === 'refuse')
          throw new Refusal(
            `the release carries ${SERVER_DIR}/, which only the server writes`,
          );
        continue;
      }
      if (!rel && entry.name === 'files.sha256') {
        if (!entry.isFile())
          throw new Refusal('files.sha256 is not a regular file');
        continue;
      }
      if (entry.isDirectory()) walk(abs, path);
      else if (entry.isFile()) files.set(path, sha256(abs));
      else if (entry.isSymbolicLink()) {
        const target = readlinkSync(abs);
        const resolved = resolve(dirname(abs), target);
        if (
          isAbsolute(target) ||
          !(resolved === root || resolved.startsWith(`${root}/`))
        )
          throw new Refusal(`${path} links outside the release`);
      } else throw new Refusal(`${path} is not a file, a folder or a link`);
    }
  };
  walk(root, '');
  return files;
}

/** #228: a v2 release is exactly what its release.json and files.sha256 say, or it is refused. */
function verifyV2Release(
  dir: string,
  commit: string,
  serverDir: 'refuse' | 'skip',
): V2Manifest {
  const checked = validateV2Manifest(readManifest(dir), commit);
  if (!checked.ok) throw new Refusal(checked.reason);
  const listPath = join(dir, 'files.sha256');
  if (!existsSync(listPath) || !lstatSync(listPath).isFile())
    throw new Refusal('the release has no files.sha256');
  const listed = checkFileList(
    readFileSync(listPath, 'utf8'),
    hashTree(dir, serverDir),
  );
  if (!listed.ok) throw new Refusal(listed.reason);
  const manifest = checked.value;
  for (const folder of [
    ...V2_PROGRAMS.map((p) => manifest.programs[p].cwd),
    manifest.migrate.cwd,
    manifest.web,
  ])
    if (!existsSync(join(dir, folder)) || !statSync(join(dir, folder)).isDirectory())
      throw new Refusal(`the release has no ${folder}/ folder`);
  return manifest;
}

/**
 * #228: what the server writes into a verified v2 release, outside files.sha256: the commit and
 * the tarball's sha256 the units hand to the programs (KS_COMMIT, KS_ARTIFACT_SHA256), and each
 * program's folder and arguments for ks2-run, so the units run exactly what release.json names.
 */
function writeServerFiles(
  dir: string,
  commit: string,
  artifact: string,
  manifest: V2Manifest,
): void {
  const programs = join(dir, SERVER_DIR, 'programs');
  mkdirSync(programs, { recursive: true });
  writeFileSync(
    join(dir, SERVER_DIR, 'release.env'),
    `KS_COMMIT=${commit}\nKS_ARTIFACT_SHA256=${artifact}\n`,
  );
  for (const name of V2_PROGRAMS) {
    const program = manifest.programs[name];
    writeFileSync(join(programs, `${name}.cwd`), `${program.cwd}\n`);
    writeFileSync(
      join(programs, `${name}.argv`),
      `${program.exec.slice(1).join('\n')}\n`,
    );
  }
}

/** The tarball sha256 the server recorded when it received a v2 release. */
function artifactOf(dir: string): string {
  const path = join(dir, SERVER_DIR, 'release.env');
  const artifact = existsSync(path)
    ? parseEnvFile(readFileSync(path, 'utf8')).KS_ARTIFACT_SHA256
    : undefined;
  if (!artifact || !/^[0-9a-f]{64}$/.test(artifact))
    throw new Refusal(`${dir} has no recorded artifact hash`);
  return artifact;
}

/** Unpacks the tarball on stdin into `dir` (files owned by root) and returns its sha256. */
async function unpackStdin(dir: string): Promise<string> {
  const hash = createHash('sha256');
  const tar = spawn('tar', ['-x', '--no-same-owner', '-C', dir], {
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  const exited = new Promise<number | null>((done) => {
    tar.on('error', () => done(null));
    tar.on('close', (code) => done(code));
  });
  const tee = new Transform({
    transform(chunk, _encoding, next) {
      hash.update(chunk);
      next(null, chunk);
    },
  });
  try {
    await pipeline(process.stdin, tee, tar.stdin);
  } catch {
    // A tar that stops reading early is reported by its exit status below.
  }
  if ((await exited) !== 0)
    throw new Refusal('the release tarball did not unpack');
  return hash.digest('hex');
}

/** Unpacks a release tarball from stdin and verifies it names `commit` and matches its hashes. */
async function receiveRelease(commit: string): Promise<void> {
  if (hasRelease(commit)) {
    say({ event: 'release-already-present', commit });
    // Drain stdin so the sender is not left writing into a closed pipe.
    spawnSync('cat', [], { stdio: ['inherit', 'ignore', 'inherit'] });
    return;
  }
  const incoming = join(RELEASES, `.incoming-${commit}-${process.pid}`);
  mkdirSync(incoming, { recursive: true });
  try {
    const artifact = await unpackStdin(incoming);
    const generation = releaseGeneration(readManifest(incoming));
    if (!generation.ok) throw new Refusal(generation.reason);
    if (generation.value === 'v1') {
      const manifest = readManifest(incoming) as {
        commit: string;
        bundles: Record<string, string>;
      };
      if (manifest.commit !== commit)
        throw new Refusal(
          `the release is for ${manifest.commit}, not ${commit}`,
        );
      for (const [file, digest] of Object.entries(manifest.bundles))
        if (sha256(join(incoming, file)) !== digest)
          throw new Refusal(`${file} does not match its recorded hash`);
    } else {
      const manifest = verifyV2Release(incoming, commit, 'refuse');
      writeServerFiles(incoming, commit, artifact, manifest);
    }
    execFileSync('chmod', ['-R', 'a+rX,go-w', incoming]);
    renameSync(incoming, join(RELEASES, commit));
    say(
      generation.value === 'v1'
        ? { event: 'release-received', commit }
        : { event: 'release-received', commit, generation: 'v2', artifact },
    );
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
      // node-postgres takes the user from the URL or PGUSER, never from the OS account.
      env: {
        PATH: '/usr/bin:/bin',
        PGUSER: 'postgres',
        KS_POOL_DATABASE_URL: url,
      },
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

/** Runs one query against the shared pool as postgres; null if it cannot be read. */
function poolCount(sql: string, variables: Record<string, string>): number | null {
  if (!existsSync(POOL_ENV)) return 0;
  const result = spawnSync(
    'psql',
    [
      '-X',
      '-A',
      '-t',
      '-v',
      'ON_ERROR_STOP=1',
      ...Object.entries(variables).flatMap(([k, v]) => ['-v', `${k}=${v}`]),
      '-d',
      'knowscroll_pool',
    ],
    {
      // On stdin, so psql interpolates :'variables'.
      input: sql,
      env: { PATH: '/usr/bin:/bin' },
      ...systemUser('postgres'),
      encoding: 'utf8',
      timeout: 15_000,
    },
  );
  const count = Number(String(result.stdout).trim());
  return result.status === 0 && Number.isInteger(count) ? count : null;
}

/** Open (claimed, not yet settled) paid orders in the shared pool, or null if it can't be read. */
function openPoolOrders(): number | null {
  return poolCount(
    "SELECT count(*) FROM pool_order WHERE state = 'claimed';\n",
    {},
  );
}

/** #228: open paid orders that one world placed (and so must settle), or null if unknown. */
function openPoolOrdersOf(world: World): number | null {
  return poolCount(
    "SELECT count(*) FROM pool_order WHERE state = 'claimed' AND ordered_by = :'world';\n",
    { world },
  );
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

/** #228: runs a v2 release's own migrate command (from its release.json) as the world's user,
 * with the world's v2 settings and database secret. v2 is never seeded. */
function migrateV2(world: World, release: string, manifest: V2Manifest): void {
  const result = spawnSync('node', manifest.migrate.exec.slice(1), {
    cwd: join(release, manifest.migrate.cwd),
    env: {
      PATH: '/usr/bin:/bin',
      ...worldEnvV2(world),
      ...parseEnvFile(
        readFileSync(join(release, SERVER_DIR, 'release.env'), 'utf8'),
      ),
      NODE_ENV: 'production',
      KS_WORLD: world,
    },
    ...serviceUser(world),
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: 10 * 60_000,
  });
  if (result.status !== 0)
    throw new Refusal(
      `the v2 migrate failed for ${world} (exit ${result.status})`,
    );
}

function systemctl(...args: string[]): void {
  execFileSync('systemctl', args, { stdio: ['ignore', 'inherit', 'inherit'] });
}

type Expectation = { world: World; commit: string; artifact?: string };

function expectationOf(world: World, slot: NonNullable<Slot>): Expectation {
  return slot.generation === 'v1'
    ? { world, commit: slot.commit }
    : {
        world,
        commit: slot.commit,
        artifact: artifactOf(join(RELEASES, slot.commit)),
      };
}

async function healthy(
  generation: Generation,
  expect: Expectation,
): Promise<boolean> {
  const port = worldPort(expect.world, generation);
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok && healthMatches(await res.json(), expect)) return true;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

function enabled(unit: string): boolean {
  return spawnSync('systemctl', ['is-enabled', '--quiet', unit]).status === 0;
}

/** Stops whatever of these units runs, and disables the target so it does not start at boot.
 * Units that are not installed (no v2 units before Ansible adds them) are simply not running. */
function stopUnits(units: { target: string; services: string[] }): void {
  const running = [units.target, ...units.services].filter(active);
  if (running.length > 0) systemctl('stop', ...running);
  if (enabled(units.target)) systemctl('disable', units.target);
}

/** Runs one generation in a world: the other generation stops first (they share the port). A
 * systemctl failure counts as unhealthy, so a deploy still falls back to the previous release. */
async function activate(
  generation: Generation,
  expect: Expectation,
): Promise<boolean> {
  const plan = activationPlan(expect.world, generation);
  try {
    stopUnits(plan.stop);
    systemctl('enable', plan.start);
    systemctl('restart', plan.start);
  } catch (error) {
    say({
      event: 'activation-failed',
      world: expect.world,
      generation,
      reason: (error as Error).message,
    });
    return false;
  }
  return healthy(generation, expect);
}

/** Cleanup after a good deploy is housekeeping: if it refuses, the deploy still stands. */
function cleanupAfterDeploy(): void {
  try {
    cleanup(false);
  } catch (error) {
    say({ event: 'cleanup-refused', reason: (error as Error).message });
  }
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
  if (!provisioned(w) && !provisionedV2(w))
    throw new Refusal(`${w} is not set up on this server yet`);

  if (source === 'stdin') await receiveRelease(commit);
  else if (!hasRelease(commit))
    throw new Refusal(`no release ${commit} on this server to reuse`);

  const release = join(RELEASES, commit);
  const generation = generationOf(release);
  if (generation === 'v1' && !provisioned(w))
    throw new Refusal(`${w} is not set up on this server yet`);
  if (generation === 'v2' && !provisionedV2(w))
    throw new Refusal(
      `${w} is not set up for v2 releases yet (apply ops/vps/ansible: ${V2_ENV(w)} and its database secret are missing)`,
    );
  const worldRoot = join(ROOT, w);
  const before = linkTarget(join(worldRoot, 'current'));
  const beforeSlot = slotOf(before);

  // v2: verify the bytes on disk again (a promotion reuses them), and never replace a v1 world's
  // generation worker while it still has a paid Reel order to settle.
  let manifest: V2Manifest | undefined;
  let artifact: string | undefined;
  if (generation === 'v2') {
    manifest = verifyV2Release(release, commit, 'skip');
    artifact = artifactOf(release);
    const from = beforeSlot?.generation ?? null;
    const decision = generationSwitchDecision(
      from,
      'v2',
      from === 'v1' ? openPoolOrdersOf(w) : 0,
    );
    if (!decision.ok) throw new Refusal(decision.reason);
  }
  say(
    generation === 'v1'
      ? { event: 'deploy-start', world: w, commit, from: commitOf(before) }
      : {
          event: 'deploy-start',
          world: w,
          commit,
          from: commitOf(before),
          generation,
          fromGeneration: beforeSlot?.generation ?? null,
          artifact,
        },
  );

  if (generation === 'v1') {
    migratePool(release);
    runAsWorld(w, release, 'migrate');
    if (w !== 'live') runAsWorld(w, release, 'seed');
  } else migrateV2(w, release, manifest as V2Manifest);

  if (before && commitOf(before) !== commit)
    relink(join(worldRoot, 'previous'), before);
  relink(join(worldRoot, 'current'), release);

  if (await activate(generation, { world: w, commit, artifact })) {
    appendFileSync(
      join(worldRoot, 'releases.log'),
      `${JSON.stringify(
        generation === 'v1'
          ? { at: new Date().toISOString(), commit, result: 'deployed', from: commitOf(before) }
          : {
              at: new Date().toISOString(),
              commit,
              result: 'deployed',
              from: commitOf(before),
              generation,
              artifact,
            },
      )}\n`,
    );
    say({ event: 'deploy-healthy', world: w, commit });
    cleanupAfterDeploy();
    return;
  }

  say({ event: 'deploy-unhealthy', world: w, commit });
  if (before) {
    relink(join(worldRoot, 'current'), before);
    const next = afterFailedDeploy(w, beforeSlot);
    let restored = false;
    try {
      if (next.action === 'stop') {
        // Before a world's first good release there is nothing to run: stop it, show the placeholder.
        stopUnits(worldUnits(w, 'v1'));
        stopUnits(worldUnits(w, 'v2'));
      } else
        restored = await activate(
          next.generation,
          expectationOf(w, {
            commit: next.commit,
            generation: next.generation,
          }),
        );
    } catch (error) {
      say({ event: 'rollback-incomplete', world: w, reason: (error as Error).message });
    }
    say({
      event: 'rolled-back',
      world: w,
      to: commitOf(before),
      generation: beforeSlot?.generation ?? null,
      healthy: restored,
    });
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
  if (!isWorld(world)) throw new Refusal(`unknown world ${JSON.stringify(world)}`);
  const w = world;
  if (!provisioned(w) && !provisionedV2(w))
    throw new Refusal(`${world} is not set up on this server`);
  const worldRoot = join(ROOT, w);
  const previous = linkTarget(join(worldRoot, 'previous'));
  const current = linkTarget(join(worldRoot, 'current'));
  const back = slotOf(previous);
  if (!previous || !back)
    throw new Refusal(`${w} has no previous release to return to`);
  if (back.generation === 'v2' && !provisionedV2(w))
    throw new Refusal(`${w} is not set up for v2 releases`);
  if (back.generation === 'v1' && !provisioned(w))
    throw new Refusal(`${w} is not set up for v1 releases`);
  const from = slotOf(current)?.generation ?? null;
  const decision = generationSwitchDecision(
    from,
    back.generation,
    from === 'v1' && back.generation === 'v2' ? openPoolOrdersOf(w) : 0,
  );
  if (!decision.ok) throw new Refusal(decision.reason);
  const expect = expectationOf(w, back);
  relink(join(worldRoot, 'current'), previous);
  if (current) relink(join(worldRoot, 'previous'), current);
  if (!(await activate(back.generation, expect)))
    throw new Refusal(`${back.commit} is not healthy on ${w} either`);
  say({ event: 'rolled-back', world: w, to: back.commit, generation: back.generation });
}

/** #228: every `current`/`previous` link under /srv/knowscroll/<folder>/, for any folder (the
 * known worlds included even before they exist), so no world's release can be missed. */
function releaseLinks(): ReleaseLink[] {
  const folders = new Set<string>(['live', 'stage', 'dev']);
  for (const entry of readdirSync(ROOT, { withFileTypes: true }))
    if (entry.isDirectory() && entry.name !== 'releases') folders.add(entry.name);
  const links: ReleaseLink[] = [];
  for (const folder of folders)
    for (const name of ['current', 'previous']) {
      const path = join(ROOT, folder, name);
      try {
        links.push({
          path,
          target: lstatSync(path).isSymbolicLink() ? readlinkSync(path) : null,
        });
      } catch (error) {
        const code = (error as { code?: string }).code;
        links.push(
          code === 'ENOENT' || code === 'ENOTDIR'
            ? { path, target: null }
            : { path, target: null, error: code ?? String(error) },
        );
      }
    }
  return links;
}

function olderThan(path: string, ms: number): boolean {
  return Date.now() - statSync(path).mtimeMs > ms;
}

export function cleanup(emergency: boolean): void {
  const DAY = 86_400_000;
  const used = releasesInUse(releaseLinks(), RELEASES);
  if (!used.ok) throw new Refusal(used.reason);
  const releases = readdirSync(RELEASES)
    .filter((name) => /^[0-9a-f]{40}$/.test(name))
    .map((commit) => ({
      commit,
      mtimeMs: statSync(join(RELEASES, commit)).mtimeMs,
    }));
  const doomed = releasesToDelete(
    releases,
    used.inUse,
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
  // #228: these are v1 programs; a v2 release has none of them.
  if (generationOf(join(RELEASES, release)) !== 'v1')
    throw new Refusal(`${w} runs a v2 release; ks run starts v1 programs only`);
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

/** The generation of the release a link names, for status; never throws. */
function generationLabel(target: string | null): Generation | 'unknown' | null {
  const commit = commitOf(target);
  if (!commit) return null;
  try {
    return generationOf(join(RELEASES, commit));
  } catch {
    return 'unknown';
  }
}

/** #228: the last nightly backup and weekly restore check, as their scripts recorded them. */
function backupStatus(): Record<string, unknown> {
  const read = (name: string): unknown => {
    try {
      return JSON.parse(readFileSync(join(BACKUPS, name), 'utf8'));
    } catch {
      return null;
    }
  };
  return { nightly: read('status.json'), restoreCheck: read('restore-check.json') };
}

export async function status(): Promise<Record<string, unknown>> {
  const worlds: Record<string, unknown> = {};
  for (const world of ['live', 'stage', 'dev'] as const) {
    if (!provisioned(world) && !provisionedV2(world)) {
      worlds[world] = { provisioned: false };
      continue;
    }
    const currentTarget = linkTarget(join(ROOT, world, 'current'));
    const generation = generationLabel(currentTarget);
    let health: unknown = 'down';
    try {
      const port = worldPort(
        world,
        generation === 'v2' || !provisioned(world) ? 'v2' : 'v1',
      );
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      health = res.ok ? await res.json() : `http ${res.status}`;
    } catch {
      // stays 'down'
    }
    const log = join(ROOT, world, 'releases.log');
    const previousTarget = linkTarget(join(ROOT, world, 'previous'));
    worlds[world] = {
      current: commitOf(currentTarget),
      previous: commitOf(previousTarget),
      generation,
      previousGeneration: generationLabel(previousTarget),
      v2Provisioned: provisionedV2(world),
      health,
      services: Object.fromEntries(
        V1_SERVICES.map((s) => [s, active(`ks-${s}@${world}.service`)]),
      ),
      v2Services: Object.fromEntries(
        V2_PROGRAMS.map((s) => [s, active(`ks2-${s}@${world}.service`)]),
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
    backups: backupStatus(),
    cutroom: await cutroomStatus(),
  };
}
