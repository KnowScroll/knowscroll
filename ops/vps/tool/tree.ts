/**
 * #228: reading a release folder and a release archive the one way the server, the release builder
 * and the CI smoke test all use (scripts/release/files.mjs re-exports this module). Reads the disk
 * but changes nothing; the rules themselves are pure and live in plan.ts. Erasable TypeScript only:
 * the server runs it with Node's own type stripping (installed beside ks.ts by ops/vps/ansible).
 */

import { createHash } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  checkTarEntries,
  type FsView,
  linkStaysInside,
  SERVER_DIR,
  symlinkHash,
  type TarEntry,
  tarEntries,
} from './plan.ts';

/** A release that breaks a rule; callers turn it into their own refusal. */
export class TreeError extends Error {}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export async function sha256Stream(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function fsView(root: string): FsView {
  return {
    kind(rel) {
      try {
        const st = lstatSync(rel ? join(root, rel) : root);
        if (st.isSymbolicLink()) return 'link';
        if (st.isDirectory()) return 'dir';
        if (st.isFile()) return 'file';
        return 'other';
      } catch {
        return 'missing';
      }
    },
    readlink: (rel) => readlinkSync(join(root, rel)),
  };
}

/**
 * Every entry under a release, keyed by relative path, as files.sha256 lists it: a regular file by
 * the sha256 of its content, a symbolic link by symlinkHash(its target). files.sha256 itself is left
 * out; the server's .ks/ folder is refused (a received release) or skipped (one the server already
 * verified and wrote into). Refused (M2): a link that does not stay inside the release at every step
 * (plan.ts linkStaysInside) or whose real path (realpath) is outside it, a dangling link, any link
 * under web/ (Caddy serves that folder; an Expo export has none), and anything that is not a file,
 * a folder or a link (devices, FIFOs, sockets).
 */
export function hashReleaseTree(
  folder: string,
  serverDir: 'refuse' | 'skip',
): Map<string, string> {
  const root = realpathSync.native(folder);
  const view = fsView(root);
  const entries = new Map<string, string>();
  const walk = (rel: string): void => {
    for (const name of readdirSync(rel ? join(root, rel) : root).sort()) {
      const path = rel ? `${rel}/${name}` : name;
      const abs = join(root, path);
      const st = lstatSync(abs);
      if (!rel && name === SERVER_DIR) {
        if (serverDir === 'refuse')
          throw new TreeError(`the release carries ${SERVER_DIR}/, which only the server writes`);
        continue;
      }
      if (!rel && name === 'files.sha256') {
        if (!st.isFile()) throw new TreeError('files.sha256 is not a regular file');
        continue;
      }
      if (st.isSymbolicLink()) {
        if (path === 'web' || path.startsWith('web/'))
          throw new TreeError(`${path} is a link inside web/, which Caddy serves; links are not allowed there`);
        const inside = linkStaysInside(view, path);
        if (!inside.ok) throw new TreeError(inside.reason);
        let real: string;
        try {
          real = realpathSync.native(abs);
        } catch {
          throw new TreeError(`${path} points at nothing`);
        }
        if (real !== root && !real.startsWith(`${root}/`))
          throw new TreeError(`${path} resolves outside the release`);
        entries.set(path, symlinkHash(readlinkSync(abs)));
      } else if (st.isDirectory()) walk(path);
      else if (st.isFile()) entries.set(path, sha256File(abs));
      else throw new TreeError(`${path} is not a file, a folder or a link`);
    }
  };
  walk('');
  return entries;
}

/** A program, migrate or web folder must be a real folder in the release, and so must every folder
 * on the way to it: never a link (M2). */
export function requireRealFolder(folder: string, rel: string): void {
  const parts = rel.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const path = parts.slice(0, i).join('/');
    let isFolder = false;
    try {
      isFolder = lstatSync(join(folder, path)).isDirectory();
    } catch {
      throw new TreeError(`the release has no ${rel}/ folder`);
    }
    if (!isFolder)
      throw new TreeError(`${path} in the release must be a real folder, not a link or a file`);
  }
}

/** The entries of a tar file on disk, read from its headers only (plan.ts tarEntries). */
export function readTarEntries(file: string): TarEntry[] {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const listed = tarEntries((offset, length) => {
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, offset);
      return buffer;
    }, size);
    if (!listed.ok) throw new TreeError(listed.reason);
    return listed.value;
  } finally {
    closeSync(fd);
  }
}

/** m6: refuses an archive before anything in it is extracted (plan.ts checkTarEntries). */
export function checkTarFile(file: string): number {
  const checked = checkTarEntries(readTarEntries(file));
  if (!checked.ok) throw new TreeError(checked.reason);
  return checked.value;
}
