import { Readable } from 'node:stream';
import { localMediaStore } from '../../../infrastructure/media-store/index.js';
import type { BackdropMedia } from '../application/face-ports.js';

/**
 * Painted backdrops in the world's media store (D-166): content-addressed stills beside the Reel video, written with the
 * same exclusive-temp-file, hash, fsync and atomic-rename steps. Nothing here reads or writes the database.
 */
export function localBackdropMedia(root: string): BackdropMedia {
  const store = localMediaStore(root);
  return {
    async put(bytes, mime) {
      const staged = await store.stage(Readable.from([Buffer.from(bytes)]), mime);
      try {
        const object = await staged.commit();
        return { key: object.key, sha256: object.sha256, size: object.size };
      } finally {
        await staged.discard();
      }
    },
    async has(key, size) {
      try {
        const file = await store.open(key);
        await file.handle.close();
        return file.size === size;
      } catch {
        return false;
      }
    },
  };
}
