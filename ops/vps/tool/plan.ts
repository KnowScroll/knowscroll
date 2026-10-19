/**
 * The server tool's decisions (#201, v2 releases #228), kept free of side effects so they can be
 * tested anywhere. ops/vps/tool/system.ts acts on them. Erasable TypeScript only: the server runs
 * this file with Node's own type stripping, no build step. scripts/release/{build,smoke}.mjs import
 * it too, so the release builder, the CI smoke test and the server check a release the same way.
 */

import { createHash } from 'node:crypto';
import { posix } from 'node:path';

export type World = 'live' | 'stage' | 'dev';

const WORLDS: readonly World[] = ['live', 'stage', 'dev'];

export function isWorld(name: string): name is World {
  return WORLDS.includes(name as World);
}

/** The branch each world follows; dev also takes any commit the agent chooses to try. */
export const BRANCH_OF: Readonly<Record<World, string>> = {
  dev: 'dev',
  stage: 'stage',
  live: 'main',
};

export type DeployRequest =
  | { ok: true; world: World; commit: string }
  | { ok: false; reason: string };

export function validateDeployRequest(
  world: string,
  commit: string,
  branch: { tip: string | null },
): DeployRequest {
  if (!WORLDS.includes(world as World))
    return { ok: false, reason: `unknown world ${JSON.stringify(world)}` };
  if (!/^[0-9a-f]{40}$/.test(commit))
    return {
      ok: false,
      reason: 'the commit must be 40 lowercase hex characters',
    };
  const w = world as World;
  if (w !== 'dev' && branch.tip !== commit)
    return {
      ok: false,
      reason: `${w} deploys only the tip of ${BRANCH_OF[w]} (${branch.tip ?? 'unknown'}), not ${commit}`,
    };
  return { ok: true, world: w, commit };
}

export type Release = { commit: string; mtimeMs: number };

/**
 * Releases cleanup may delete: never one any world uses now or used last (`inUse`); of the
 * rest, keep the `keepNewest` most recent and select the others, oldest first.
 */
export function releasesToDelete(
  releases: readonly Release[],
  inUse: ReadonlySet<string>,
  keepNewest: number,
): string[] {
  const unused = releases
    .filter((r) => !inUse.has(r.commit))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return unused
    .slice(keepNewest)
    .sort((a, b) => a.mtimeMs - b.mtimeMs)
    .map((r) => r.commit);
}

/** One `current` or `previous` link found under /srv/knowscroll/<anything>/ (#228). */
export type ReleaseLink = {
  path: string;
  target: string | null;
  error?: string;
};

/**
 * #228: the releases some world uses now or used last, whatever their generation and whichever
 * folder the world lives in. A link that cannot be read, or that points into the releases folder
 * at something this tool cannot name, makes the answer unknown: cleanup then deletes nothing
 * rather than guess (the bug this fixes: a release nobody could name was simply "not in use").
 * Links that point elsewhere (the placeholder, Cutroom's own releases) are not about releases.
 */
export function releasesInUse(
  links: readonly ReleaseLink[],
  releasesRoot: string,
):
  | { ok: true; inUse: Set<string> }
  | { ok: false; reason: string } {
  const inUse = new Set<string>();
  for (const link of links) {
    if (link.error)
      return {
        ok: false,
        reason: `cannot read ${link.path} (${link.error}), so the releases in use are unknown; nothing is deleted`,
      };
    if (link.target === null) continue;
    const resolved = posix.resolve(posix.dirname(link.path), link.target);
    if (!resolved.startsWith(`${releasesRoot}/`)) continue;
    const name = resolved.slice(releasesRoot.length + 1).split('/')[0] ?? '';
    if (!/^[0-9a-f]{40}$/.test(name))
      return {
        ok: false,
        reason: `${link.path} points at ${link.target}, which is not a release this tool can name; nothing is deleted`,
      };
    inUse.add(name);
  }
  return { ok: true, inUse };
}

export type DiskGuardDecision =
  | 'fine'
  | 'warn'
  | 'critical'
  | 'still-critical'
  | 'recovered';

/** 80 % warns; 90 % is critical (deploys refused, optional services paused, emergency cleanup);
 * once critical, the flag clears only below 85 %, so the guard cannot flap around one number. */
export function diskGuardDecision(
  usedPercent: number,
  flagPresent: boolean,
): DiskGuardDecision {
  if (flagPresent) return usedPercent < 85 ? 'recovered' : 'still-critical';
  if (usedPercent >= 90) return 'critical';
  if (usedPercent >= 80) return 'warn';
  return 'fine';
}

export function parseEnvFile(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match) env[match[1] as string] = match[2] as string;
  }
  return env;
}

/** #199: the programs `ks run <world> <program>` may start, as the world's own user. */
const RUNNABLE_PROGRAMS: readonly string[] = [
  'generation-cli',
  'publication',
  'install-supply',
];

export type RunRequest =
  | { ok: true; world: World; program: string }
  | { ok: false; reason: string };

export function validateRunRequest(world: string, program: string): RunRequest {
  if (!WORLDS.includes(world as World))
    return { ok: false, reason: `unknown world ${JSON.stringify(world)}` };
  if (!RUNNABLE_PROGRAMS.includes(program))
    return {
      ok: false,
      reason: `ks run starts only ${RUNNABLE_PROGRAMS.join(', ')}; not ${JSON.stringify(program)}`,
    };
  return { ok: true, world: world as World, program };
}

/** #199: the shared Cutroom is never restarted or switched while a paid order is open: a crash or
 * stop mid-run makes it re-run that job after a 4 h lease, which can pay twice for work in flight. */
export function cutroomSwitchDecision(openOrders: number | null): {
  ok: boolean;
  reason: string;
} {
  if (openOrders === null)
    return {
      ok: false,
      reason: 'the shared pool could not be read, so open orders are unknown',
    };
  if (openOrders > 0)
    return {
      ok: false,
      reason: `${openOrders} paid order(s) are still open in the shared pool; try again once they settle`,
    };
  return { ok: true, reason: 'no open orders' };
}

// ---------------------------------------------------------------------------------------------
// #228: v2 releases. A v2 release is release-<commit>.tar whose root holds release.json (schema
// ks-release.v2), files.sha256 (every file except itself), api/, worker/ and web/. A release.json
// without a schema is a v1 release and keeps behaving exactly as before.
// ---------------------------------------------------------------------------------------------

export type Generation = 'v1' | 'v2';

export const V2_SCHEMA = 'ks-release.v2';

/** The programs this server's v2 units run (ks2-api@, ks2-worker@): a v2 release names exactly these. */
export const V2_PROGRAMS = ['api', 'worker'] as const;
export type V2ProgramName = (typeof V2_PROGRAMS)[number];

/** The services a v1 world runs (ks-<service>@<world>), as `ks status` reports them. */
export const V1_SERVICES = ['api', 'worker', 'maintenance', 'generation'] as const;

/** Written by the server only, inside a received v2 release; a release that carries it is refused. */
export const SERVER_DIR = '.ks';

export type V2Program = { cwd: string; exec: string[] };

export type V2Manifest = {
  schema: typeof V2_SCHEMA;
  commit: string;
  builtAt: string;
  node: string;
  programs: Record<V2ProgramName, V2Program>;
  migrate: V2Program;
  web: 'web';
  migrations: string[];
};

type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Which generation a parsed release.json is: no `schema` is v1; ks-release.v2 is v2; anything else is refused. */
export function releaseGeneration(manifest: unknown): Checked<Generation> {
  if (!isRecord(manifest))
    return { ok: false, reason: 'release.json is not a JSON object' };
  if (!('schema' in manifest)) return { ok: true, value: 'v1' };
  if (manifest.schema === V2_SCHEMA) return { ok: true, value: 'v2' };
  return {
    ok: false,
    reason: `release.json names an unknown schema ${JSON.stringify(manifest.schema)}`,
  };
}

/** A folder inside the release: plain relative segments, nothing that could climb out. */
export function isSafeFolder(path: string): boolean {
  return (
    typeof path === 'string' &&
    path.split('/').every((s) => /^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(s))
  );
}

/** A file path as files.sha256 lists it: relative, no empty, `.` or `..` segment, and nothing
 * sha256sum would have to escape (newline, carriage return, backslash) or that ends a C string. */
export function isSafeFilePath(path: string): boolean {
  if (path === '' || path.startsWith('/') || /[\0\n\r\\]/.test(path))
    return false;
  return path.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

function checkProgram(value: unknown, label: string): Checked<V2Program> {
  if (!isRecord(value))
    return { ok: false, reason: `${label} must be {"cwd", "exec"}` };
  if (typeof value.cwd !== 'string' || !isSafeFolder(value.cwd))
    return {
      ok: false,
      reason: `${label}.cwd must be a plain folder inside the release`,
    };
  const exec = value.exec;
  if (
    !Array.isArray(exec) ||
    exec.length < 2 ||
    exec[0] !== 'node' ||
    !exec.every(
      (a) => typeof a === 'string' && a !== '' && !/[\0\n\r]/.test(a),
    )
  )
    return {
      ok: false,
      reason: `${label}.exec must be ["node", ...arguments] with non-empty, single-line arguments`,
    };
  return { ok: true, value: { cwd: value.cwd, exec: [...exec] as string[] } };
}

/** The release.json of a v2 release, checked against the commit it must be for. */
export function validateV2Manifest(
  manifest: unknown,
  commit: string,
): Checked<V2Manifest> {
  if (!isRecord(manifest) || manifest.schema !== V2_SCHEMA)
    return {
      ok: false,
      reason: `release.json is not a ${V2_SCHEMA} manifest`,
    };
  if (manifest.commit !== commit)
    return {
      ok: false,
      reason: `the release is for ${JSON.stringify(manifest.commit)}, not ${commit}`,
    };
  if (
    typeof manifest.builtAt !== 'string' ||
    Number.isNaN(Date.parse(manifest.builtAt))
  )
    return { ok: false, reason: 'release.json builtAt must be an ISO time' };
  if (typeof manifest.node !== 'string' || manifest.node === '')
    return { ok: false, reason: 'release.json node must name a Node version' };
  if (!isRecord(manifest.programs))
    return { ok: false, reason: 'release.json programs must be an object' };
  const named = Object.keys(manifest.programs).sort();
  const expected = [...V2_PROGRAMS].sort();
  if (named.join(',') !== expected.join(','))
    return {
      ok: false,
      reason: `release.json must name exactly the programs ${expected.join(', ')} (this server has units for those), not ${named.join(', ') || 'none'}`,
    };
  const programs: Partial<Record<V2ProgramName, V2Program>> = {};
  for (const name of V2_PROGRAMS) {
    const program = checkProgram(manifest.programs[name], `programs.${name}`);
    if (!program.ok) return program;
    programs[name] = program.value;
  }
  const migrate = checkProgram(manifest.migrate, 'migrate');
  if (!migrate.ok) return migrate;
  if (manifest.web !== 'web')
    return {
      ok: false,
      reason: 'release.json web must be "web" (Caddy serves current/web)',
    };
  if (
    !Array.isArray(manifest.migrations) ||
    !manifest.migrations.every((m) => typeof m === 'string')
  )
    return {
      ok: false,
      reason: 'release.json migrations must be a list of names',
    };
  return {
    ok: true,
    value: {
      schema: V2_SCHEMA,
      commit,
      builtAt: manifest.builtAt,
      node: manifest.node,
      programs: programs as Record<V2ProgramName, V2Program>,
      migrate: migrate.value,
      web: 'web',
      migrations: [...manifest.migrations] as string[],
    },
  };
}

/** Parses files.sha256 (`<sha256>  <path>` per line, as sha256sum writes it). */
export function parseSha256List(text: string): Checked<Map<string, string>> {
  const entries = new Map<string, string>();
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  for (const [index, line] of lines.entries()) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (!match)
      return {
        ok: false,
        reason: `files.sha256 line ${index + 1} is not "<sha256>  <path>"`,
      };
    const hash = match[1] as string;
    const path = match[2] as string;
    if (!isSafeFilePath(path))
      return {
        ok: false,
        reason: `files.sha256 names an unsafe path ${JSON.stringify(path)}`,
      };
    if (entries.has(path))
      return {
        ok: false,
        reason: `files.sha256 lists ${JSON.stringify(path)} twice`,
      };
    entries.set(path, hash);
  }
  if (entries.size === 0)
    return { ok: false, reason: 'files.sha256 lists no files' };
  return { ok: true, value: entries };
}

/**
 * files.sha256 must describe the release completely: every listed entry present with its hash, and
 * no entry the list does not name. `actual` maps each regular file's relative path to the sha256 of
 * its content and each symbolic link's path to symlinkHash(its target) (ops/vps/tool/tree.ts),
 * leaving out files.sha256 itself and the server's own .ks/ folder.
 */
export function checkFileList(
  listing: string,
  actual: ReadonlyMap<string, string>,
): Checked<number> {
  const parsed = parseSha256List(listing);
  if (!parsed.ok) return parsed;
  const problems: string[] = [];
  for (const [path, hash] of parsed.value) {
    const found = actual.get(path);
    if (found === undefined) problems.push(`missing ${path}`);
    else if (found !== hash) problems.push(`hash mismatch ${path}`);
  }
  for (const path of actual.keys())
    if (!parsed.value.has(path)) problems.push(`not listed ${path}`);
  if (problems.length > 0)
    return {
      ok: false,
      reason: `files.sha256 does not match the release (${problems.length} problem(s)): ${problems.slice(0, 5).join('; ')}${problems.length > 5 ? '; …' : ''}`,
    };
  return { ok: true, value: parsed.value.size };
}

/** The systemd units of one generation in one world. */
export function worldUnits(
  world: World,
  generation: Generation,
): { target: string; services: string[] } {
  return generation === 'v1'
    ? {
        target: `ks-world@${world}.target`,
        services: V1_SERVICES.map((s) => `ks-${s}@${world}.service`),
      }
    : {
        target: `ks2-world@${world}.target`,
        services: V2_PROGRAMS.map((s) => `ks2-${s}@${world}.service`),
      };
}

/**
 * What switching a world to `generation` does: the other generation's target and services are
 * stopped (if running) and its target disabled, so the two never hold the world's port at once
 * or both start at boot; then this generation's target is enabled and restarted.
 */
export function activationPlan(
  world: World,
  generation: Generation,
): { stop: { target: string; services: string[] }; start: string } {
  const other: Generation = generation === 'v1' ? 'v2' : 'v1';
  return {
    stop: worldUnits(world, other),
    start: worldUnits(world, generation).target,
  };
}

export type Slot = { commit: string; generation: Generation } | null;

/**
 * After a deploy did not become healthy: `current` goes back to what it was. If that was a release
 * (of either generation), that generation is started again; before a world's first good release
 * (the placeholder) both generations are stopped.
 */
export function afterFailedDeploy(
  world: World,
  before: Slot,
):
  | { action: 'restore'; commit: string; generation: Generation; plan: ReturnType<typeof activationPlan> }
  | { action: 'stop'; targets: string[] } {
  if (!before)
    return {
      action: 'stop',
      targets: [worldUnits(world, 'v1').target, worldUnits(world, 'v2').target],
    };
  return {
    action: 'restore',
    commit: before.commit,
    generation: before.generation,
    plan: activationPlan(world, before.generation),
  };
}

/**
 * #228: replacing a world's v1 release by a v2 one stops v1's generation worker, which settles the
 * paid Reel orders this world placed. Never while one is open (or while that cannot be known).
 */
export function generationSwitchDecision(
  from: Generation | null,
  to: Generation,
  openOrdersOfWorld: number | null,
): { ok: boolean; reason: string } {
  if (!(from === 'v1' && to === 'v2'))
    return { ok: true, reason: 'no v1 generation worker is replaced' };
  if (openOrdersOfWorld === null)
    return {
      ok: false,
      reason:
        "the shared pool could not be read, so it is unknown whether this world's v1 generation worker still follows a paid order",
    };
  if (openOrdersOfWorld > 0)
    return {
      ok: false,
      reason: `${openOrdersOfWorld} paid Reel order(s) this world placed are still open; its v1 generation worker must settle them before v2 replaces it`,
    };
  return { ok: true, reason: 'this world has no open paid order' };
}

/** What a world's /health must say after a deploy: its world and commit, and for a v2 release the
 * sha256 of the exact tarball the server received. */
export function healthMatches(
  body: unknown,
  expect: { world: string; commit: string; artifact?: string },
): boolean {
  if (!isRecord(body)) return false;
  if (body.commit !== expect.commit || body.world !== expect.world)
    return false;
  return expect.artifact === undefined || body.artifact === expect.artifact;
}

// ---------------------------------------------------------------------------------------------
// #228 review fixes: links in files.sha256 and physical link containment (M2), the tar listing
// before extraction (m6), current/previous only after a healthy switch (m1, m8), the deploy lock
// (m2, m7), cleanup steps (m7), the migrate session and the pre-migrate dump (m10).
// ---------------------------------------------------------------------------------------------

/** How files.sha256 lists a symbolic link: the sha256 of "symlink:" + its target, as written. */
export function symlinkHash(target: string): string {
  return createHash('sha256').update(`symlink:${target}`).digest('hex');
}

/** The commit a `current`/`previous` link target names, or null (the placeholder, nothing). */
export function commitOfTarget(target: string | null): string | null {
  const match = target ? /\/releases\/([0-9a-f]{40})\/?$/.exec(target) : null;
  return match ? (match[1] as string) : null;
}

/** What one path inside a release is, without following links; '' is the release itself. */
export type FsView = {
  kind(rel: string): 'file' | 'dir' | 'link' | 'missing' | 'other';
  readlink(rel: string): string;
};

/**
 * M2: follows the link at `linkRel` the way the kernel would, one path component at a time, and
 * accepts it only if every step stays inside the release (never above its root, never through an
 * absolute target) and it ends at something that exists. A lexical check is not enough: with
 * `s -> .`, the target `s/s/../../etc` reads as inside but climbs out.
 */
export function linkStaysInside(fs: FsView, linkRel: string): Checked<string> {
  const hops = { count: 0 };
  const start = linkRel.split('/').slice(0, -1);
  const resolved = followTarget(fs, start, fs.readlink(linkRel), hops);
  if (typeof resolved === 'string')
    return { ok: false, reason: `${linkRel}: ${resolved}` };
  return { ok: true, value: resolved.join('/') };
}

function followTarget(
  fs: FsView,
  from: string[],
  target: string,
  hops: { count: number },
): string[] | string {
  if (target.startsWith('/')) return `links to an absolute path (${target})`;
  if (target === '') return 'links to nothing';
  let current = [...from];
  const parts = target.split('/').filter((p) => p !== '' && p !== '.');
  for (const [index, part] of parts.entries()) {
    const last = index === parts.length - 1;
    if (part === '..') {
      if (current.length === 0) return `climbs out of the release (${target})`;
      current.pop();
      continue;
    }
    const next = [...current, part];
    const kind = fs.kind(next.join('/'));
    if (kind === 'missing') return `points at nothing (${target})`;
    if (kind === 'link') {
      hops.count += 1;
      if (hops.count > 40) return 'has too many levels of links';
      const inner = followTarget(fs, current, fs.readlink(next.join('/')), hops);
      if (typeof inner === 'string') return inner;
      current = inner;
      if (!last && fs.kind(current.join('/')) !== 'dir')
        return `goes through something that is not a folder (${target})`;
      continue;
    }
    if (!last && kind !== 'dir')
      return `goes through something that is not a folder (${target})`;
    current = next;
  }
  return current;
}

/** One entry of a tar archive as its headers describe it, before anything is extracted. */
export type TarEntry = { path: string; type: string; link: string };

function cString(bytes: Uint8Array, start: number, length: number): string {
  const slice = bytes.subarray(start, start + length);
  const end = slice.indexOf(0);
  return new TextDecoder().decode(end === -1 ? slice : slice.subarray(0, end));
}

function paxRecords(text: string): Record<string, string> {
  const records: Record<string, string> = {};
  let rest = text;
  while (rest.length > 0) {
    const space = rest.indexOf(' ');
    const length = Number(rest.slice(0, space));
    if (space <= 0 || !Number.isInteger(length) || length <= space) break;
    const record = rest.slice(space + 1, length - 1);
    const eq = record.indexOf('=');
    if (eq > 0) records[record.slice(0, eq)] = record.slice(eq + 1);
    rest = rest.slice(length);
  }
  return records;
}

/**
 * m6: the entries of a tar archive (POSIX ustar, GNU long names and links, pax path records), read
 * from its headers only. `read(offset, length)` returns bytes of the archive, `size` is its length.
 * A header whose checksum is wrong, or a size field this reader does not handle, is refused.
 * (Byte offsets of pax records are treated as characters: KnowScroll paths are ASCII.)
 */
export function tarEntries(
  read: (offset: number, length: number) => Uint8Array,
  size: number,
): Checked<TarEntry[]> {
  const entries: TarEntry[] = [];
  let offset = 0;
  let longName: string | null = null;
  let longLink: string | null = null;
  let pax: Record<string, string> = {};
  while (offset + 512 <= size) {
    const header = read(offset, 512);
    if (header.every((b) => b === 0)) break;
    let sum = 0;
    for (let i = 0; i < 512; i++)
      sum += i >= 148 && i < 156 ? 32 : (header[i] as number);
    const recorded = Number.parseInt(cString(header, 148, 8).trim(), 8);
    if (recorded !== sum)
      return { ok: false, reason: `tar header at byte ${offset} is corrupt` };
    if (((header[124] as number) & 0x80) !== 0)
      return { ok: false, reason: `tar entry at byte ${offset} has a size this reader refuses` };
    const length = Number.parseInt(cString(header, 124, 12).trim() || '0', 8);
    if (!Number.isInteger(length) || length < 0)
      return { ok: false, reason: `tar entry at byte ${offset} has no readable size` };
    const flag = header[156] as number;
    const type = flag === 0 ? '0' : String.fromCharCode(flag);
    const dataStart = offset + 512;
    const next = dataStart + Math.ceil(length / 512) * 512;
    if (next > size)
      return { ok: false, reason: 'the tar archive is cut short' };
    if (type === 'L' || type === 'K' || type === 'x') {
      const data = read(dataStart, length);
      if (type === 'L') longName = cString(data, 0, length);
      else if (type === 'K') longLink = cString(data, 0, length);
      else pax = { ...pax, ...paxRecords(new TextDecoder().decode(data)) };
      offset = next;
      continue;
    }
    if (type === 'g') {
      offset = next;
      continue;
    }
    let name = cString(header, 0, 100);
    // POSIX ustar ("ustar\0") keeps a path prefix at 345; GNU's "ustar  " uses those bytes otherwise.
    if (cString(header, 257, 6) === 'ustar' && header[262] === 0) {
      const prefix = cString(header, 345, 155);
      if (prefix) name = `${prefix}/${name}`;
    }
    entries.push({
      path: pax.path ?? longName ?? name,
      type,
      link: pax.linkpath ?? longLink ?? cString(header, 157, 100),
    });
    longName = null;
    longLink = null;
    pax = {};
    offset = next;
  }
  return { ok: true, value: entries };
}

/** A path as a tar entry names it: no leading `/`, no `..`; `.` segments are dropped. */
function archivePath(path: string): string[] | null {
  if (path.startsWith('/') || /[\0\n\r\\]/.test(path)) return null;
  const parts = path.split('/').filter((p) => p !== '' && p !== '.');
  return parts.includes('..') ? null : parts;
}

/**
 * m6: what may be extracted, decided from the listing alone: regular files, folders, symbolic links
 * and hard links to a regular file listed before; nothing with an absolute path or `..`; no device,
 * FIFO or other special entry; nothing written through a link the archive itself made; no `.ks/`.
 * Where a symbolic link points is checked after extraction (linkStaysInside).
 */
export function checkTarEntries(entries: readonly TarEntry[]): Checked<number> {
  const files = new Set<string>();
  const seen = new Set<string>();
  const links: string[] = [];
  for (const entry of entries) {
    const parts = archivePath(entry.path);
    if (parts === null)
      return { ok: false, reason: `the archive names an unsafe path ${JSON.stringify(entry.path)}` };
    const path = parts.join('/');
    if (entry.type !== '5') {
      if (seen.has(path))
        return { ok: false, reason: `the archive names ${path} twice` };
      seen.add(path);
    }
    if (parts[0] === '.ks')
      return { ok: false, reason: 'the archive carries .ks/, which only the server writes' };
    if (links.some((l) => path === l || path.startsWith(`${l}/`)))
      return { ok: false, reason: `${path} would be written through a link` };
    if (entry.type === '0') files.add(path);
    else if (entry.type === '2') {
      if (entry.link.startsWith('/') || entry.link === '')
        return { ok: false, reason: `${path} links to an absolute path` };
      links.push(path);
    } else if (entry.type === '1') {
      const target = archivePath(entry.link);
      if (target === null || !files.has(target.join('/')))
        return { ok: false, reason: `${path} is a hard link to something that is not a file before it` };
      files.add(path);
    } else if (entry.type !== '5')
      return { ok: false, reason: `${path} is not a file, a folder or a link (tar type ${JSON.stringify(entry.type)})` };
  }
  return { ok: true, value: entries.length };
}

/** The `current` and `previous` links of a world (their targets, or null when absent). */
export type Links = { current: string | null; previous: string | null };

/**
 * m1: a deploy points `current` at the new release while it starts. Only once it is healthy does
 * `previous` become the release that ran before (unless that was the same commit or nothing); a
 * deploy that fails leaves both links exactly as they were.
 */
export function linksAfterDeploy(
  before: Links,
  release: string,
  commit: string,
  healthy: boolean,
): Links {
  if (!healthy) return before;
  return {
    current: release,
    previous:
      before.current !== null && commitOfTarget(before.current) !== commit
        ? before.current
        : before.previous,
  };
}

/** m8: a rollback swaps the links; if what it returns to is not healthy, both go back as they were. */
export function linksAfterRollback(before: Links, healthy: boolean): Links {
  return healthy ? { current: before.previous, previous: before.current } : before;
}

export const DEPLOY_LOCK = '/run/knowscroll/deploy.lock';

/** #199 programs that can claim a paid Reel order (operator.ts ledger.claim); m2: they hold the lock. */
const CLAIMING_PROGRAMS: readonly string[] = ['generation-cli'];

/**
 * m2, m7: which `ks` commands run under the deploy lock. `wait`: queue for it (deploy and promote
 * already hold it through ks-gate; the rest re-run themselves under flock). `try`: the disk guard
 * never waits; while a deploy holds the lock it does everything except deleting releases.
 */
export function lockNeeded(command: string, args: readonly string[]): 'wait' | 'try' | 'none' {
  if (['deploy', 'promote', 'rollback', 'cleanup'].includes(command)) return 'wait';
  if (command === 'run' && CLAIMING_PROGRAMS.includes(args[1] ?? '')) return 'wait';
  if (command === 'disk-guard') return 'try';
  return 'none';
}

/**
 * m2: whether this process runs under the deploy lock, i.e. its parent is the `flock` that holds a
 * write lock on the lock file (ks-gate and the documented commands run `flock … deploy.lock ks …`).
 * `procLocks` is /proc/locks; `inode` is the lock file's inode number.
 */
export function deployLockHeldByParent(
  procLocks: string,
  inode: number,
  parentPid: number,
): boolean {
  return procLocks.split('\n').some((line) => {
    const match =
      /^\d+:\s+FLOCK\s+\S+\s+WRITE\s+(\d+)\s+[0-9a-f]+:[0-9a-f]+:(\d+)\s/.exec(line);
    return (
      match !== null &&
      Number(match[1]) === parentPid &&
      Number(match[2]) === inode
    );
  });
}

/**
 * m10: the database URL a v2 migrate gets: the world's own, with session settings added as libpq
 * `options` (node-postgres reads them from the URL), so a long migration is bounded by its own
 * statement timeout instead of the role's 30 s, and the role itself is not loosened.
 */
export function withSessionOptions(
  url: string,
  settings: Readonly<Record<string, string>>,
): string {
  const options = Object.entries(settings)
    .map(([key, value]) => `-c ${key}=${value}`)
    .join(' ');
  const parsed = new URL(url);
  const existing = parsed.searchParams.get('options');
  parsed.searchParams.delete('options');
  const value = existing ? `${existing} ${options}` : options;
  // Percent-encoded (spaces as %20, not +), which every URL reader decodes the same way.
  return `${parsed.toString()}${parsed.search ? '&' : '?'}options=${encodeURIComponent(value)}`;
}

/** m10: the file name of the dump taken before a v2 migrate, sortable by time. */
export function predeployDumpName(at: Date, commit: string): string {
  const stamp = at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `pre-deploy-${stamp}-${commit.slice(0, 12)}.dump`;
}

/**
 * m7: runs each step even when an earlier one failed, and reports which failed, so one unreadable
 * link cannot stop the temp sweep or the journal vacuum.
 */
export function runSteps(
  steps: ReadonlyArray<{ name: string; run: () => void }>,
): { failed: Array<{ step: string; reason: string }> } {
  const failed: Array<{ step: string; reason: string }> = [];
  for (const step of steps) {
    try {
      step.run();
    } catch (error) {
      failed.push({ step: step.name, reason: (error as Error).message });
    }
  }
  return { failed };
}

/** m4: a release's .sha256 file is exactly one line, `<sha256>  release-<commit>.tar`. */
export function checksumFor(text: string, tarName: string): Checked<string> {
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  const match = lines.length === 1 ? /^([0-9a-f]{64}) {2}(.+)$/.exec(lines[0] as string) : null;
  if (!match || match[2] !== tarName)
    return { ok: false, reason: `the checksum file must be one line "<sha256>  ${tarName}"` };
  return { ok: true, value: match[1] as string };
}
