import { mkdtemp, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { localMediaStore, MAX_MEDIA_BYTES } from './index.js';
import { byteRange } from './range.js';
const roots: string[] = [];
async function root() {
  const path = await mkdtemp(join(tmpdir(), 'ks-media-'));
  roots.push(path);
  return path;
}
afterEach(async () => {
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});

describe('logical local media objects', () => {
  it('exposes only complete committed bytes, verifies hashes and is idempotent', async () => {
    const path = await root();
    const store = localMediaStore(path);
    const staged = await store.stage(Readable.from([Buffer.from('fixture bytes')]));
    const key = `sha256/${staged.sha256.slice(0, 2)}/${staged.sha256}.mp4`;
    await expect(store.open(key)).rejects.toThrow();
    const first = await staged.commit();
    const same = await store.stage(Readable.from([Buffer.from('fixture bytes')]));
    expect(await same.commit()).toEqual(first);
    const file = await store.open(key);
    try {
      expect(await file.handle.readFile('utf8')).toBe('fixture bytes');
    } finally {
      await file.handle.close();
    }
    expect((await readdir(path)).filter((entry) => entry.startsWith('.import-'))).toEqual([]);
  });
  it('refuses traversal, symlink roots, empty/oversize streams and removes failed staging files', async () => {
    const path = await root();
    const store = localMediaStore(path);
    await expect(store.open('../../elsewhere')).rejects.toThrow('invalid_key');
    await expect(store.stage(Readable.from([]))).rejects.toThrow('size');
    await expect(store.stage(Readable.from([Buffer.alloc(MAX_MEDIA_BYTES), Buffer.from('x')]))).rejects.toThrow('size');
    const link = join(path, 'linked');
    await symlink(await root(), link);
    await expect(localMediaStore(link).stage(Readable.from(['x']))).rejects.toThrow('unsafe_path');
    expect((await readdir(path)).filter((entry) => entry.startsWith('.import-'))).toEqual([]);
  });
});

describe('single HTTP byte ranges', () => {
  it.each([
    [undefined, { kind: 'full' }],
    ['bytes=0-0', { kind: 'range', start: 0, end: 0 }],
    ['bytes=4-', { kind: 'range', start: 4, end: 9 }],
    ['bytes=-3', { kind: 'range', start: 7, end: 9 }],
    ['bytes=-30', { kind: 'range', start: 0, end: 9 }],
    ['bytes=8-200', { kind: 'range', start: 8, end: 9 }],
    ['bytes=10-', { kind: 'unsatisfiable' }],
    ['bytes=8-7', { kind: 'unsatisfiable' }],
    ['bytes=-0', { kind: 'unsatisfiable' }],
    ['bytes=0-2,4-5', { kind: 'unsatisfiable' }],
    ['bytes=9007199254740993-', { kind: 'unsatisfiable' }],
    ['units=0-2', { kind: 'unsatisfiable' }],
  ])('handles %s', (header, expected) => {
    expect(byteRange(header, 10)).toEqual(expected);
  });
});
