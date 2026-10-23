import { constants, createReadStream } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink, type FileHandle } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';

export const MAX_MEDIA_BYTES = 64 * 1024 * 1024;
const keyPattern = /^sha256\/[0-9a-f]{2}\/[0-9a-f]{64}\.mp4$/;
export interface MediaObject {
  readonly key: string;
  readonly sha256: string;
  readonly size: number;
  readonly mime: 'video/mp4';
  readonly backend: 'local';
}
export interface StagedMedia {
  readonly sha256: string;
  readonly size: number;
  /** Adapter-local temporary location; never put it in a document, contract or diagnostic. */
  readonly path: string;
  commit(): Promise<MediaObject>;
  discard(): Promise<void>;
}
export interface MediaStore {
  stage(stream: Readable): Promise<StagedMedia>;
  open(key: string): Promise<{ readonly handle: FileHandle; readonly size: number }>;
}

export class MediaRefusal extends Error {
  constructor(readonly code: 'invalid_key' | 'unsafe_path' | 'size' | 'checksum') {
    super(code);
  }
}

/** Owner-only root; every directory and opened file is checked without following symlinks. */
export function localMediaStore(root: string): MediaStore {
  const base = resolve(root);
  async function directory(path: string): Promise<void> {
    if (path !== base) await directory(dirname(path));
    let created = true;
    await mkdir(path, { mode: 0o750 }).catch((error: NodeJS.ErrnoException) => {
      created = false;
      if (error.code !== 'EEXIST') throw error;
    });
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(path)) !== path)
      throw new MediaRefusal('unsafe_path');
    if (created) {
      // Persist each newly-created directory entry, including ancestors of the final key.
      const parent = await open(dirname(path), constants.O_RDONLY);
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    }
  }
  async function safeOpen(key: string) {
    if (!keyPattern.test(key) || key.slice(7, 9) !== key.slice(10, 12)) throw new MediaRefusal('invalid_key');
    await directory(dirname(join(base, key)));
    const handle = await open(join(base, key), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_MEDIA_BYTES) {
      await handle.close();
      throw new MediaRefusal('size');
    }
    return { handle, size: stat.size };
  }
  return {
    open: safeOpen,
    async stage(stream) {
      await directory(base);
      const temporary = join(base, `.import-${randomUUID()}.tmp`);
      const file = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o640,
      );
      let size = 0;
      const hash = createHash('sha256');
      try {
        for await (const raw of stream) {
          const chunk: Buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
          size += chunk.length;
          if (size > MAX_MEDIA_BYTES) throw new MediaRefusal('size');
          hash.update(chunk);
          let offset = 0;
          while (offset < chunk.length) offset += (await file.write(chunk, offset)).bytesWritten;
        }
        if (size === 0) throw new MediaRefusal('size');
        await file.sync();
      } catch (error) {
        stream.destroy();
        await file.close();
        await unlink(temporary);
        throw error;
      }
      await file.close();
      const sha256 = hash.digest('hex');
      const key = `sha256/${sha256.slice(0, 2)}/${sha256}.mp4`;
      let ended = false;
      return {
        sha256,
        size,
        path: temporary,
        async discard() {
          if (!ended) {
            ended = true;
            await unlink(temporary);
          }
        },
        async commit() {
          if (ended) throw new Error('staged_media_ended');
          const destination = join(base, key);
          await directory(dirname(destination));
          // An existing object must really have the claimed digest; never trust its filename.
          try {
            const existing = await safeOpen(key);
            const check = createHash('sha256');
            try {
              for await (const chunk of existing.handle.createReadStream({ autoClose: false }))
                check.update(chunk as Uint8Array);
            } finally {
              await existing.handle.close();
            }
            if (existing.size !== size || check.digest('hex') !== sha256) throw new MediaRefusal('checksum');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
          await rename(temporary, destination);
          ended = true;
          const folder = await open(dirname(destination), constants.O_RDONLY);
          try {
            await folder.sync();
          } finally {
            await folder.close();
          }
          return { key, sha256, size, backend: 'local', mime: 'video/mp4' };
        },
      };
    },
  };
}

export function mediaReadStream(file: { handle: FileHandle }, range?: { start: number; end: number }): Readable {
  return createReadStream('', { fd: file.handle.fd, autoClose: false, ...range });
}
