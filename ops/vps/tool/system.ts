/**
 * The server tool's actions (#201): unpack and verify releases, migrate as the world's own user,
 * switch the `current` link, restart and health-check a world, roll back, clean up, and guard the
 * disk. Decisions come from plan.ts; reading a release folder or archive is tree.ts, shared with
 * the release builder and the CI smoke test. Runs as root on the server through `ks` (ks.ts);
 * every step either completes or leaves the previous state in place, and says which on stderr.
 *
 * #228: two release generations. A release.json without `schema` is v1 and is handled as before
 * (dist/*.mjs bundles, migrate-pool, migrate, seed, ks-world@<world>.target). A `ks-release.v2`
 * release is verified entry by entry against files.sha256 (files and links), dumped-then-migrated
 * with the command its release.json names (as the world's user, with the world's v2 settings,
 * never seeded), and run by ks2-world@<world>.target. Switching a world between generations stops
 * the other generation's units first; `previous` changes only once the new release is healthy, and
 * a failed switch restores both links, but only restarts old v2 code when its complete schema
 * still matches. Otherwise v2 stops and a reviewed forward recovery is required.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
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
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  activationPlan,
  activateAfterSchemaCheck,
  afterFailedDeploy,
  BRANCH_OF,
  checkFileList,
  commitOfTarget,
  cutroomSwitchDecision,
  DEPLOY_LOCK,
  deployLockHeldByParent,
  diskGuardDecision,
  type Generation,
  generationSwitchDecision,
  healthMatches,
  isWorld,
  type Links,
  linksAfterDeploy,
  linksAfterRollback,
  MAX_SCHEMA_MIGRATIONS,
  type MigrationIdentity,
  parseEnvFile,
  predeployDumpName,
  prepareV2Deployment,
  type ReleaseLink,
  releaseGeneration,
  recoverFailedActivation,
  releasesInUse,
  releasesToDelete,
  runSteps,
  SERVER_DIR,
  type Slot,
  type V2Manifest,
  V2_PROGRAMS,
  V1_SERVICES,
  validateDeployRequest,
  validateRunRequest,
  validateV2Manifest,
  v2SchemaCompatibility,
  withSessionOptions,
  type World,
  worldUnits,
} from './plan.ts';
import {
  checkTarFile,
  hashReleaseTree,
  requireRealFolder,
  TreeError,
} from './tree.ts';

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
// m10: a v2 migrate's own session limit (the world role keeps its 30 s for everything else).
const MIGRATE_STATEMENT_TIMEOUT = '15min';

export class Refusal extends Error {}

function say(event: Record<string, unknown>): void {
  process.stderr.write(
    `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`,
  );
}

/** A broken release rule (tree.ts) is a refusal like any other. */
function refusalFrom(error: unknown): Error {
  return error instanceof TreeError ? new Refusal(error.message) : (error as Error);
}

/**
 * m2: whether ks runs under the deploy lock. ks-gate runs deploy and promote as
 * `sudo flock … deploy.lock ks …` (sudo names that command in SUDO_COMMAND); the documented manual
 * commands and ks's own re-run (ks.ts) are `flock … deploy.lock ks …`, so the lock's holder in
 * /proc/locks is ks's parent.
 */
export function holdsDeployLock(): boolean {
  const viaGate = process.env.SUDO_COMMAND ?? '';
  if (viaGate.startsWith('/usr/bin/flock ') && viaGate.includes(` ${DEPLOY_LOCK} `))
    return true;
  try {
    return deployLockHeldByParent(
      readFileSync('/proc/locks', 'utf8'),
      statSync(DEPLOY_LOCK).ino,
      process.ppid,
    );
  } catch {
    return false;
  }
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

/** The user a world's programs run as: `ks-<world>` for v1, `ks2-<world>` for v2 (#226 review m6). */
function serviceUser(world: World, generation: Generation = 'v1'): { uid: number; gid: number } {
  const name = generation === 'v1' ? `ks-${world}` : `ks2-${world}`;
  const line = readFileSync('/etc/passwd', 'utf8')
    .split('\n')
    .find((l) => l.startsWith(`${name}:`));
  if (!line) throw new Refusal(`no service user ${name}`);
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

const commitOf = commitOfTarget;

/** Points `link` at `target` atomically (a new link renamed over the old one). */
function relink(link: string, target: string): void {
  const temp = `${link}.next`;
  rmSync(temp, { force: true });
  symlinkSync(target, temp);
  renameSync(temp, link);
}

/** Puts a world's `current` and `previous` links exactly as `links` says (absent when null). */
function applyLinks(worldRoot: string, links: Links): void {
  for (const name of ['current', 'previous'] as const) {
    const path = join(worldRoot, name);
    const target = links[name];
    if (target === null) {
      if (linkTarget(path) !== null) unlinkSync(path);
    } else if (linkTarget(path) !== target) relink(path, target);
  }
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

/** The commit and generation a link names, or null for the placeholder. An unknown manifest must
 * never bypass v2's activation guard by being assumed to be a legacy release. */
function slotOf(target: string | null): Slot {
  const commit = commitOf(target);
  if (!commit) return null;
  try {
    return { commit, generation: generationOf(join(RELEASES, commit)) };
  } catch (error) {
    say({
      event: 'release-generation-unknown',
      commit,
    });
    throw new Refusal('the linked release generation is unknown; activation refused');
  }
}

/**
 * #228: a v2 release is exactly what its release.json and files.sha256 say, or it is refused: the
 * manifest's shape and commit; real folders (never links) for every program, migrate and web; and
 * every file and link listed with its hash, nothing unlisted, links inside the release (tree.ts).
 */
function verifyV2Release(
  dir: string,
  commit: string,
  serverDir: 'refuse' | 'skip',
): V2Manifest {
  const checked = validateV2Manifest(readManifest(dir), commit);
  if (!checked.ok) throw new Refusal(checked.reason);
  const manifest = checked.value;
  const listPath = join(dir, 'files.sha256');
  if (!existsSync(listPath) || !lstatSync(listPath).isFile())
    throw new Refusal('the release has no files.sha256');
  try {
    for (const folder of [
      ...V2_PROGRAMS.map((p) => manifest.programs[p].cwd),
      manifest.migrate.cwd,
      manifest.web,
    ])
      requireRealFolder(dir, folder);
    const listed = checkFileList(
      readFileSync(listPath, 'utf8'),
      hashReleaseTree(dir, serverDir),
    );
    if (!listed.ok) throw new Refusal(listed.reason);
  } catch (error) {
    throw refusalFrom(error);
  }
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

/** Saves the tarball on stdin to `file` (root only) and returns its sha256. */
async function saveStdin(file: string): Promise<string> {
  const hash = createHash('sha256');
  const tee = new Transform({
    transform(chunk, _encoding, next) {
      hash.update(chunk);
      next(null, chunk);
    },
  });
  await pipeline(
    process.stdin,
    tee,
    createWriteStream(file, { flags: 'wx', mode: 0o600 }),
  );
  return hash.digest('hex');
}

/**
 * m6: the archive is listed first and refused (devices, FIFOs, absolute paths, `..`, writes through
 * links, .ks/) before anything is extracted; then it is extracted with root as owner and the
 * umask's modes, and every mode is normalised (owner rw, others r, x kept; no set-id, no sticky).
 */
function extractRelease(archive: string, dir: string): void {
  try {
    checkTarFile(archive);
  } catch (error) {
    throw refusalFrom(error);
  }
  const tar = spawnSync(
    'tar',
    ['-x', '--no-same-owner', '--no-same-permissions', '-f', archive, '-C', dir],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );
  if (tar.status !== 0) throw new Refusal('the release tarball did not unpack');
  normaliseModes(dir);
}

function normaliseModes(dir: string): void {
  execFileSync('chmod', ['-R', 'u=rwX,go=rX', dir]);
}

/** Receives a release tarball on stdin and verifies it names `commit` and matches its hashes. */
async function receiveRelease(commit: string): Promise<void> {
  if (hasRelease(commit)) {
    say({ event: 'release-already-present', commit });
    // Drain stdin so the sender is not left writing into a closed pipe.
    spawnSync('cat', [], { stdio: ['inherit', 'ignore', 'inherit'] });
    return;
  }
  const incoming = join(RELEASES, `.incoming-${commit}-${process.pid}`);
  const archive = `${incoming}.tar`;
  mkdirSync(incoming, { recursive: true });
  try {
    let artifact: string;
    try {
      artifact = await saveStdin(archive);
    } catch {
      throw new Refusal('the release tarball could not be received');
    }
    extractRelease(archive, incoming);
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
      normaliseModes(join(incoming, SERVER_DIR));
    }
    renameSync(incoming, join(RELEASES, commit));
    say(
      generation.value === 'v1'
        ? { event: 'release-received', commit }
        : { event: 'release-received', commit, generation: 'v2', artifact },
    );
  } finally {
    rmSync(incoming, { recursive: true, force: true });
    rmSync(archive, { force: true });
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

/** #250: only this world's v2 migration metadata, via local peer auth. No settings/secret file,
 * URL, legacy/owner/pool database, application row or raw psql output reaches this boundary. */
function readV2Schema(world: World): unknown {
  if (process.getuid?.() !== 0 || !isWorld(world)) return null;
  try {
    const result = spawnSync('/usr/bin/psql', [
      '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '--dbname', `knowscroll_v2_${world}`,
    ], {
      input: `begin read only isolation level repeatable read;
        select json_build_object(
          'migrations', (select coalesce(json_agg(name order by timestamp, name), '[]'::json)
            from (select name, timestamp from migrator.kysely_migration
              order by timestamp, name limit ${MAX_SCHEMA_MIGRATIONS + 1}) applied),
          'checksums', (select coalesce(json_agg(row_to_json(recorded) order by name), '[]'::json)
            from (select name, sha256 from migrator.migration_checksum
              order by name limit ${MAX_SCHEMA_MIGRATIONS + 1}) recorded));
        commit;`,
      env: { PATH: '/usr/bin:/bin', PGCONNECT_TIMEOUT: '2',
        PGOPTIONS: '-c statement_timeout=3000 -c lock_timeout=1000' },
      ...systemUser('postgres'), encoding: 'utf8', timeout: 5000, maxBuffer: 128 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (result.status !== 0 || result.error || result.stdout.length > 128 * 1024) return null;
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function requireMatchingV2Schema(world: World, commit: string): void {
  const release = join(RELEASES, commit);
  const manifest = verifyV2Release(release, commit, 'skip');
  const target: MigrationIdentity[] = [];
  try {
    for (const name of manifest.migrations) {
      const path = join(release, manifest.programs.api.cwd,
        'node_modules/@knowscroll/migrations', `${name}.sql`);
      if (!lstatSync(path).isFile()) throw new Error('missing SQL');
      target.push({ name, sha256: sha256(path) });
    }
  } catch {
    throw new Refusal('the verified target migration SQL cannot be read; activation refused');
  }
  const decision = v2SchemaCompatibility(target, readV2Schema(world));
  if (!decision.ok) throw new Refusal(decision.reason);
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

/**
 * m10: before every v2 migrate, a pg_dump -Fc of the world's v2 database beside the nightly dumps
 * (/srv/knowscroll/backups/knowscroll_v2_<world>/pre-deploy-<time>-<commit>.dump, 0700/0600 root),
 * readable back by pg_restore --list, or nothing is migrated. Rolling a migration back means
 * restoring this dump (docs/v2/operations/backups.md).
 */
function predeployDump(world: World, commit: string): string {
  const database = `knowscroll_v2_${world}`;
  const folder = join(BACKUPS, database);
  mkdirSync(BACKUPS, { recursive: true, mode: 0o700 });
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const name = predeployDumpName(new Date(), commit);
  const partial = join(folder, `.${name}.partial`);
  const fd = openSync(partial, 'wx', 0o600);
  let kept = false;
  try {
    const dump = spawnSync(
      '/usr/sbin/runuser',
      ['-u', 'postgres', '--', '/usr/bin/pg_dump', '--format=custom', `--dbname=${database}`],
      { stdio: ['ignore', fd, 'inherit'], env: { PATH: '/usr/bin:/bin' }, timeout: 15 * 60_000 },
    );
    if (dump.status !== 0)
      throw new Refusal(`the pre-migrate dump of ${database} failed; nothing was migrated`);
    const list = spawnSync('/usr/bin/pg_restore', ['--list', partial], {
      stdio: ['ignore', 'ignore', 'inherit'],
      env: { PATH: '/usr/bin:/bin' },
    });
    if (list.status !== 0)
      throw new Refusal(`the pre-migrate dump of ${database} cannot be read back; nothing was migrated`);
    renameSync(partial, join(folder, name));
    kept = true;
  } finally {
    closeSync(fd);
    if (!kept) rmSync(partial, { force: true });
  }
  say({ event: 'predeploy-dump', world, database, file: name });
  return name;
}

/** #228: runs a v2 release's own migrate command (from its release.json) as the world's v2 user,
 * with the world's v2 settings and database secret, never seeded. m10: the migrate session gets
 * its own statement timeout through the connection options; the role's 30 s stays for the rest. */
function migrateV2(world: World, release: string, manifest: V2Manifest): void {
  const env = worldEnvV2(world);
  const session = { statement_timeout: MIGRATE_STATEMENT_TIMEOUT };
  if (!env.DATABASE_URL)
    throw new Refusal(`${V2_SECRET_ENV(world)} names no DATABASE_URL`);
  const result = spawnSync('node', manifest.migrate.exec.slice(1), {
    cwd: join(release, manifest.migrate.cwd),
    env: {
      PATH: '/usr/bin:/bin',
      ...env,
      DATABASE_URL: withSessionOptions(env.DATABASE_URL, session),
      PGOPTIONS: `-c statement_timeout=${MIGRATE_STATEMENT_TIMEOUT}`,
      ...parseEnvFile(
        readFileSync(join(release, SERVER_DIR, 'release.env'), 'utf8'),
      ),
      NODE_ENV: 'production',
      KS_WORLD: world,
    },
    ...serviceUser(world, 'v2'),
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: 20 * 60_000,
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

/** #250: explicit stop suppresses Restart=on-failure; disable every v2 unit before any dump/DDL.
 * Never touches legacy v1, whose database remains separate until normal accepted activation. */
function quiesceV2(world: World): void {
  const units = worldUnits(world, 'v2');
  systemctl('stop', units.target, ...units.services);
  systemctl('disable', units.target, ...units.services);
}

/** Runs one generation in a world: the other generation stops first (they share the port). A
 * systemctl failure counts as unhealthy, so a deploy still falls back to the previous release. */
async function activate(
  generation: Generation,
  expect: Expectation,
  pointCurrent: () => void = () => {},
): Promise<boolean> {
  const plan = activationPlan(expect.world, generation);
  try {
    return await activateAfterSchemaCheck(generation, {
      checkV2Schema: () => requireMatchingV2Schema(expect.world, expect.commit),
      pointCurrent,
      start: async () => {
        stopUnits(plan.stop);
        systemctl('enable', plan.start);
        systemctl('restart', plan.start);
        return healthy(generation, expect);
      },
    });
  } catch (error) {
    say({
      event: 'activation-failed',
      world: expect.world,
      generation,
      reason: (error as Error).message,
    });
    return false;
  }
}

/** Restore only compatible code. Stop unsafe v2 BEFORE restoring old links: an automatic systemd
 * restart must not pick old code while its schema check is pending. Never throws. */
async function restoreRunning(world: World, before: Slot, restoreLinks: () => void): Promise<boolean> {
  const next = afterFailedDeploy(world, before);
  try {
    if (next.action === 'stop') {
      // Before a world's first good release there is nothing to run: stop it, show the placeholder.
      stopUnits(worldUnits(world, 'v1'));
      stopUnits(worldUnits(world, 'v2'));
      restoreLinks();
      return false;
    }
    const restored = await recoverFailedActivation(next.generation, {
      activate: () => activate(next.generation,
        expectationOf(world, { commit: next.commit, generation: next.generation }), restoreLinks),
      stopV2: () => quiesceV2(world),
      restoreLinks,
    });
    if (!restored) say({ event: 'restore-incomplete', world,
      ...(next.generation === 'v2' ? { forwardRecoveryRequired: true } : {}) });
    return restored;
  } catch (error) {
    say({ event: 'restore-incomplete', world, reason: (error as Error).message });
    return false;
  }
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
  const before: Links = {
    current: linkTarget(join(worldRoot, 'current')),
    previous: linkTarget(join(worldRoot, 'previous')),
  };
  const beforeSlot = slotOf(before.current);

  // v2: verify the bytes on disk again (a promotion reuses them), and never replace a v1 world's
  // generation worker while it still has a paid Reel order to settle. ks holds the deploy lock
  // here (ks.ts), and every order-claiming `ks run` takes the same lock (m2): no claim can slip in
  // between this check and the switch.
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
      ? { event: 'deploy-start', world: w, commit, from: commitOf(before.current) }
      : {
          event: 'deploy-start',
          world: w,
          commit,
          from: commitOf(before.current),
          generation,
          fromGeneration: beforeSlot?.generation ?? null,
          artifact,
        },
  );

  let dump: string | undefined;
  let migrationFailed = false;
  if (generation === 'v1') {
    migratePool(release);
    runAsWorld(w, release, 'migrate');
    if (w !== 'live') runAsWorld(w, release, 'seed');
  } else {
    try {
      dump = prepareV2Deployment({
        quiesce: () => quiesceV2(w),
        dump: () => predeployDump(w, commit),
        migrate: () => migrateV2(w, release, manifest as V2Manifest),
      });
    } catch {
      // Even a failed migrate may have changed metadata/DDL. Only an actual schema read can
      // authorize restarting the old v2 release; never infer rollback from the command's exit.
      migrationFailed = true;
      say({ event: 'v2-preparation-failed', world: w, commit });
    }
  }

  // Schema check precedes even the temporary current-link mutation; previous stays untouched.
  if (!migrationFailed && await activate(generation, { world: w, commit, artifact },
    () => relink(join(worldRoot, 'current'), release))) {
    applyLinks(worldRoot, linksAfterDeploy(before, release, commit, true));
    appendFileSync(
      join(worldRoot, 'releases.log'),
      `${JSON.stringify(
        generation === 'v1'
          ? { at: new Date().toISOString(), commit, result: 'deployed', from: commitOf(before.current) }
          : {
              at: new Date().toISOString(),
              commit,
              result: 'deployed',
              from: commitOf(before.current),
              generation,
              artifact,
              predeployDump: dump,
            },
      )}\n`,
    );
    say({ event: 'deploy-healthy', world: w, commit });
    cleanupAfterDeploy();
    return;
  }

  say({ event: 'deploy-unhealthy', world: w, commit });
  // Stop incompatible v2 before restoring old links, including systemd's restart path.
  const restored = await restoreRunning(w, beforeSlot,
    () => applyLinks(worldRoot, linksAfterDeploy(before, release, commit, false)));
  say({
    event: restored ? 'rolled-back' : 'recovery-incomplete',
    world: w,
    to: commitOf(before.current),
    generation: beforeSlot?.generation ?? null,
    healthy: restored,
    ...(beforeSlot?.generation === 'v2' && !restored ? { forwardRecoveryRequired: true } : {}),
  });
  appendFileSync(
    join(worldRoot, 'releases.log'),
    `${JSON.stringify({ at: new Date().toISOString(), commit,
      result: restored ? 'failed-and-rolled-back' : 'failed-recovery-incomplete' })}\n`,
  );
  throw new Refusal(
    restored ? `${commit} did not become healthy on ${w}; the previous release is back` :
      `${commit} failed on ${w}; recovery is incomplete; a reviewed forward recovery is required`,
  );
}

export async function rollback(world: string): Promise<void> {
  if (!isWorld(world)) throw new Refusal(`unknown world ${JSON.stringify(world)}`);
  const w = world;
  if (!provisioned(w) && !provisionedV2(w))
    throw new Refusal(`${world} is not set up on this server`);
  const worldRoot = join(ROOT, w);
  const before: Links = {
    current: linkTarget(join(worldRoot, 'current')),
    previous: linkTarget(join(worldRoot, 'previous')),
  };
  const back = slotOf(before.previous);
  if (!before.previous || !back)
    throw new Refusal(`${w} has no previous release to return to`);
  if (back.generation === 'v2' && !provisionedV2(w))
    throw new Refusal(`${w} is not set up for v2 releases`);
  if (back.generation === 'v1' && !provisioned(w))
    throw new Refusal(`${w} is not set up for v1 releases`);
  // m10: a v2 release is verified again before it runs, as a promotion does.
  if (back.generation === 'v2')
    requireMatchingV2Schema(w, back.commit);
  const fromSlot = slotOf(before.current);
  const from = fromSlot?.generation ?? null;
  const decision = generationSwitchDecision(
    from,
    back.generation,
    from === 'v1' && back.generation === 'v2' ? openPoolOrdersOf(w) : 0,
  );
  if (!decision.ok) throw new Refusal(decision.reason);
  const expect = expectationOf(w, back);
  if (await activate(back.generation, expect,
    () => applyLinks(worldRoot, linksAfterRollback(before, true)))) {
    say({ event: 'rolled-back', world: w, to: back.commit, generation: back.generation });
    return;
  }
  // m8: like a failed deploy, a failed rollback puts both links and what ran before back.
  const restored = await restoreRunning(w, fromSlot,
    () => applyLinks(worldRoot, linksAfterRollback(before, false)));
  say({
    event: 'rollback-failed',
    world: w,
    tried: back.commit,
    restored: commitOf(before.current),
    healthy: restored,
  });
  throw new Refusal(
    restored ? `${back.commit} is not healthy on ${w}; the release that ran before the rollback is back` :
      `${back.commit} failed on ${w}; recovery is incomplete; a reviewed forward recovery is required`,
  );
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

/**
 * Old releases, interrupted uploads, stale media temp files and (in an emergency) the journal.
 * m7: each step runs even when another fails, and failures are reported (the command then exits
 * non-zero); `deleteReleases` is false when the disk guard found a deploy holding the lock, so it
 * leaves releases for the next run. ks.ts runs `ks cleanup` under the deploy lock.
 */
export function cleanup(emergency: boolean, deleteReleases = true): void {
  const DAY = 86_400_000;
  let doomed: string[] = [];
  let temps = 0;
  const { failed } = runSteps([
    {
      name: 'releases',
      run: () => {
        if (!deleteReleases) return;
        const used = releasesInUse(releaseLinks(), RELEASES);
        if (!used.ok) throw new Error(used.reason);
        const releases = readdirSync(RELEASES)
          .filter((name) => /^[0-9a-f]{40}$/.test(name))
          .map((commit) => ({
            commit,
            mtimeMs: statSync(join(RELEASES, commit)).mtimeMs,
          }));
        doomed = releasesToDelete(
          releases,
          used.inUse,
          emergency ? 2 : KEEP_UNUSED_RELEASES,
        );
        for (const commit of doomed)
          rmSync(join(RELEASES, commit), { recursive: true, force: true });
      },
    },
    {
      // Interrupted uploads (folders and their .tar) a day old: nobody is coming back for them.
      name: 'interrupted uploads',
      run: () => {
        for (const name of readdirSync(RELEASES))
          if (name.startsWith('.incoming-') && olderThan(join(RELEASES, name), DAY)) {
            rmSync(join(RELEASES, name), { recursive: true, force: true });
            temps++;
          }
      },
    },
    {
      // Media imports leave temp files in v1's media/tmp and v2's media-v2/tmp.
      name: 'media temp files',
      run: () => {
        for (const world of ['live', 'stage', 'dev'] as const)
          for (const media of ['media', 'media-v2']) {
            const tmp = join(ROOT, world, media, 'tmp');
            if (!existsSync(tmp)) continue;
            for (const name of readdirSync(tmp))
              if (name.endsWith('.tmp') && olderThan(join(tmp, name), DAY)) {
                unlinkSync(join(tmp, name));
                temps++;
              }
          }
      },
    },
    ...(emergency
      ? [
          {
            name: 'journal',
            run: () => {
              execFileSync('journalctl', ['--vacuum-size=500M'], {
                stdio: ['ignore', 'ignore', 'inherit'],
              });
            },
          },
        ]
      : []),
  ]);
  say({
    event: 'cleanup',
    emergency,
    releasesDeleted: doomed,
    ...(deleteReleases ? {} : { releasesSkipped: 'a deploy holds the lock' }),
    tempFilesDeleted: temps,
    ...(failed.length > 0 ? { failed } : {}),
  });
  if (failed.length > 0)
    throw new Refusal(
      `cleanup could not finish ${failed.map((f) => f.step).join(', ')}: ${failed.map((f) => f.reason).join('; ')}`,
    );
}

function usedPercent(): number {
  const s = statfsSync('/');
  const used = s.blocks - s.bfree;
  return (100 * used) / (used + s.bavail);
}

function active(unit: string): boolean {
  return spawnSync('systemctl', ['is-active', '--quiet', unit]).status === 0;
}

/** `deleteReleases` is false while a deploy holds the lock (ks.ts): the guard never waits for one. */
export function diskGuard(deleteReleases = true): void {
  mkdirSync(RUN, { recursive: true });
  const used = usedPercent();
  const decision = diskGuardDecision(used, existsSync(DISK_FLAG));
  const percent = Math.round(used * 10) / 10;
  if (decision === 'fine') return;
  if (decision === 'warn')
    return say({ event: 'disk-warning', usedPercent: percent });
  if (decision === 'still-critical') {
    say({ event: 'disk-still-critical', usedPercent: percent });
    return cleanup(true, deleteReleases);
  }
  if (decision === 'critical') {
    const paused = PAUSABLE.filter(active);
    writeFileSync(
      DISK_FLAG,
      `${JSON.stringify({ since: new Date().toISOString(), paused })}\n`,
    );
    for (const unit of paused) systemctl('stop', unit);
    say({ event: 'disk-critical', usedPercent: percent, paused });
    return cleanup(true, deleteReleases);
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
      // m9: paid Reel orders this world placed and has not settled (v1 → v2 waits for zero).
      openPoolOrders: openPoolOrdersOf(world),
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
