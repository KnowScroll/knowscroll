// Shared by scripts/release/build.mjs and smoke.mjs (#228): hashing a release folder the way the
// server does (ops/vps/tool/system.ts hashTree), and finding a tar that can write a reproducible
// archive. The comparison rules themselves live in ops/vps/tool/plan.ts and are imported from there.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/** Reserved for the server: it writes .ks/ into a release after verifying it. */
export const SERVER_DIR = '.ks';

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export async function sha256Stream(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/**
 * Every regular file under `root` with its sha256, keyed by relative path (files.sha256 itself
 * left out). Links must be relative and stay inside `root`; a .ks/ folder at the top, or anything
 * that is not a file, a folder or such a link, is an error.
 */
export function hashTree(folder) {
  const root = resolve(folder);
  const files = new Map();
  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      const abs = join(dir, entry.name);
      if (!rel && entry.name === SERVER_DIR)
        throw new Error(`${SERVER_DIR}/ is reserved for the server`);
      if (!rel && entry.name === 'files.sha256') continue;
      if (entry.isDirectory()) walk(abs, path);
      else if (entry.isFile()) files.set(path, sha256File(abs));
      else if (entry.isSymbolicLink()) {
        const target = readlinkSync(abs);
        const resolved = resolve(dirname(abs), target);
        if (isAbsolute(target) || !(resolved === root || resolved.startsWith(`${root}/`)))
          throw new Error(`${path} links outside the release (${target})`);
      } else throw new Error(`${path} is not a file, a folder or a link`);
    }
  };
  walk(root, '');
  return files;
}

/** GNU tar (as `tar` on Linux, `gtar` from Homebrew on a Mac), or null. */
export function gnuTar() {
  for (const bin of ['tar', 'gtar']) {
    const result = spawnSync(bin, ['--version'], { encoding: 'utf8' });
    if (result.status === 0 && /GNU tar/.test(result.stdout)) return bin;
  }
  return null;
}
