/**
 * ADR-0023 section 4 — pure filesystem primitives for verified media import. No HTTP, no
 * database, no worker loop: `import.ts` is the only caller, and it owns the ffprobe/policy checks.
 * A Cutroom engine path is untrusted host metadata (ADR-0007/ADR-0020); every function here treats
 * its filesystem inputs as adversarial rather than trusted configuration.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';

/** Migration 0013's own ceiling on `media_object.byte_size`. */
export const MAX_MEDIA_BYTES = 512 * 1024 * 1024;

/** Exactly migration 0013's `media_object.storage_key` CHECK: `sha256/<aa>/<bb>/<sha>.mp4`. */
export function computeStorageKey(sha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('sha256 must be 64 lowercase hex characters');
  return `sha256/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}.mp4`;
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

export type ContainmentReason = 'not_absolute' | 'root_unresolvable' | 'path_unresolvable' | 'not_contained';
export type ContainmentOutcome = { ok: true; realPath: string } | { ok: false; reason: ContainmentReason };

/**
 * `candidate` must be absolute and its realpath must sit strictly inside `root`'s own realpath.
 * A root-equal candidate resolves to an empty relative path and is refused (a directory is not a
 * file); a `..` escape and a symlink that resolves outside the root are both refused here, before
 * anything looks at what `candidate` itself is (see `checkRegularFile` for that).
 */
export async function checkContainment(root: string, candidate: string): Promise<ContainmentOutcome> {
  if (!isAbsolute(candidate)) return { ok: false, reason: 'not_absolute' };
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    return { ok: false, reason: 'root_unresolvable' };
  }
  let realCandidate: string;
  try {
    realCandidate = await realpath(candidate);
  } catch {
    return { ok: false, reason: 'path_unresolvable' };
  }
  const rel = relative(realRoot, realCandidate);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return { ok: false, reason: 'not_contained' };
  return { ok: true, realPath: realCandidate };
}

export type FileKindReason = 'missing' | 'symlink' | 'directory' | 'other';
export type FileKindOutcome = { ok: true; sizeBytes: number } | { ok: false; reason: FileKindReason };

/**
 * `lstat`s the ORIGINAL candidate path, never the resolved realpath: a symlink whose target is an
 * ordinary file genuinely inside the root is still refused here, because the candidate itself is a
 * link, not a plain file.
 */
export async function checkRegularFile(candidate: string): Promise<FileKindOutcome> {
  let info;
  try {
    info = await lstat(candidate);
  } catch (error) {
    return { ok: false, reason: isEnoent(error) ? 'missing' : 'other' };
  }
  if (info.isSymbolicLink()) return { ok: false, reason: 'symlink' };
  if (info.isDirectory()) return { ok: false, reason: 'directory' };
  if (!info.isFile()) return { ok: false, reason: 'other' };
  return { ok: true, sizeBytes: info.size };
}

export interface StreamCopyResult {
  sha256: string;
  byteSize: number;
}

/**
 * Stream-copies `sourcePath` into a freshly created `destPath` (which must not already exist)
 * while hashing every byte, then fsyncs the written file (reopened by path, after the write
 * stream's own fd has closed — simpler and more robust than sharing one fd across a stream and an
 * explicit fsync). The caller is responsible for fsyncing the containing directory and for the
 * eventual rename into the content-addressed store.
 */
export async function streamCopyWithHash(sourcePath: string, destPath: string): Promise<StreamCopyResult> {
  const hash = createHash('sha256');
  let byteSize = 0;
  await new Promise<void>((resolvePromise, reject) => {
    const source = createReadStream(sourcePath);
    const writable = createWriteStream(destPath, { flags: 'wx', mode: 0o600 });
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      source.destroy();
      writable.destroy();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    source.on('error', fail);
    writable.on('error', fail);
    source.on('data', (chunk: string | Buffer) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(buffer);
      byteSize += buffer.byteLength;
    });
    writable.on('close', () => {
      if (settled) return;
      settled = true;
      resolvePromise();
    });
    source.pipe(writable);
  });
  const handle = await open(destPath, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { sha256: hash.digest('hex'), byteSize };
}

/** fsyncs a directory so a preceding write/rename inside it is durable before the next step. */
export async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
}

export interface StoreResult {
  storageKey: string;
  absolutePath: string;
  /** false when the same content-addressed key already existed (idempotent import). */
  created: boolean;
}

/**
 * Atomically installs an already-fsynced `tempPath` at its content-addressed location under
 * `mediaRoot`. If the destination already exists — the same bytes were imported before — the temp
 * file is discarded and `created:false` is returned, so importing the same bytes twice never
 * duplicates the write or leaves two files behind.
 */
export async function installAtContentAddress(tempPath: string, mediaRoot: string, sha256: string): Promise<StoreResult> {
  const storageKey = computeStorageKey(sha256);
  const absolutePath = join(mediaRoot, storageKey);
  const directory = dirname(absolutePath);
  await mkdir(directory, { recursive: true });
  if (await pathExists(absolutePath)) {
    await rm(tempPath, { force: true });
    return { storageKey, absolutePath, created: false };
  }
  await rename(tempPath, absolutePath);
  await fsyncDirectory(directory);
  return { storageKey, absolutePath, created: true };
}

export interface Mp4BoxOrder {
  moovOffset: number | null;
  mdatOffset: number | null;
}

const MAX_BOX_SCAN_ITERATIONS = 100_000;

/**
 * Reads only top-level MP4/QuickTime box headers (never the whole file) to find where the first
 * top-level `moov` and `mdat` boxes start. A file is "progressive" (faststart) exactly when its
 * `moov` offset is present and comes before its `mdat` offset. Bounded iteration and a
 * strictly-increasing-position check keep this safe against a malformed or adversarial container.
 */
export async function readMp4BoxOrder(path: string): Promise<Mp4BoxOrder> {
  const handle = await open(path, 'r');
  try {
    const size = (await handle.stat()).size;
    let pos = 0;
    let moovOffset: number | null = null;
    let mdatOffset: number | null = null;
    const header = Buffer.alloc(16);
    for (let i = 0; i < MAX_BOX_SCAN_ITERATIONS && pos < size; i++) {
      const { bytesRead } = await handle.read(header, 0, 16, pos);
      if (bytesRead < 8) break; // truncated header at EOF; stop scanning
      let boxSize = header.readUInt32BE(0);
      const type = header.toString('latin1', 4, 8);
      let headerSize = 8;
      if (boxSize === 1) {
        if (bytesRead < 16) break;
        const high = header.readUInt32BE(8);
        const low = header.readUInt32BE(12);
        boxSize = high * 2 ** 32 + low;
        headerSize = 16;
      } else if (boxSize === 0) {
        boxSize = size - pos; // last box extends to EOF
      }
      if (type === 'moov' && moovOffset === null) moovOffset = pos;
      if (type === 'mdat' && mdatOffset === null) mdatOffset = pos;
      if (moovOffset !== null && mdatOffset !== null) break;
      if (boxSize < headerSize) break; // malformed box; refuse to loop forever
      pos += boxSize;
    }
    return { moovOffset, mdatOffset };
  } finally {
    await handle.close();
  }
}
