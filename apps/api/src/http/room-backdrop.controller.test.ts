import 'reflect-metadata';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { Request, Response } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MediaStore } from '@knowscroll/backend/infrastructure/media-store';
import type { ReadRoomBackdrop } from '@knowscroll/backend/modules/rooms';
import { RoomBackdropController } from './room-backdrop.controller.js';
import type { AuthenticatedCallers, Caller } from './callers.js';

/** A labelled CI FIXTURE picture: a few JPEG header bytes, never provider output. */
const BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const DIGEST = 'ab'.repeat(32);
const caller: Caller = {
  accountId: '00000000-0000-4000-8000-000000000001',
  universeId: '00000000-0000-4000-8000-000000000002',
  privacyEpoch: 1,
  sessionId: '00000000-0000-4000-8000-000000000003',
  credential: 'bearer',
};

let folder: string;
beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), 'ks-room-art-'));
  await writeFile(join(folder, 'still.jpg'), BYTES);
});
afterAll(async () => {
  await rm(folder, { recursive: true, force: true });
});

/** Only the key the backdrop names is openable; every other key is missing. */
const store: MediaStore = {
  stage: () => Promise.reject(new Error('not used')),
  async open(key) {
    if (key !== 'sha256/ab/still.jpg') throw new Error('ENOENT');
    const handle = await open(join(folder, 'still.jpg'), 'r');
    return { handle, size: (await handle.stat()).size };
  },
};

const approved: ReadRoomBackdrop = (digest) =>
  Promise.resolve(
    digest === DIGEST ? { key: 'sha256/ab/still.jpg', mime: 'image/jpeg' as const, size: BYTES.length } : undefined,
  );

interface Sent {
  status: number;
  headers: Record<string, string | number>;
  body: Buffer;
}

/** Runs one request through the controller against a recording stand-in for the response. */
async function request(
  options: {
    method?: 'GET' | 'HEAD';
    digest?: string;
    signedIn?: boolean;
    headers?: Record<string, string>;
    size?: number;
  } = {},
): Promise<Sent> {
  const callers: AuthenticatedCallers = {
    resolve: () => Promise.resolve(options.signedIn === false ? undefined : caller),
    sessionValid: () => Promise.resolve(true),
  };
  const controller = new RoomBackdropController(
    options.size === undefined
      ? approved
      : (digest) => approved(digest).then((row) => row && { ...row, size: options.size! }),
    store,
    callers,
  );
  const stream = new PassThrough();
  const sent: Sent = { status: 200, headers: {}, body: Buffer.alloc(0) };
  const chunks: Buffer[] = [];
  const done = new Promise<void>((resolve) => {
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', resolve);
  });
  const response = Object.assign(stream, {
    setHeader: (name: string, value: string | number) => {
      sent.headers[name.toLowerCase()] = value;
      return response;
    },
    status(code: number) {
      sent.status = code;
      return response;
    },
    json: () => response.end(),
  }) as unknown as Response;
  const method = options.method ?? 'GET';
  const req = { method, headers: options.headers ?? {} } as unknown as Request;
  const digest = options.digest ?? DIGEST;
  if (method === 'HEAD') await controller.head(digest, req, response);
  else await controller.get(digest, req, response);
  // Every path ends the response itself: a problem, a 304 and a HEAD call `end`, and a picture ends when its pipe does.
  await done;
  sent.body = Buffer.concat(chunks);
  return sent;
}

describe('RoomBackdropController', () => {
  it('serves an approved backdrop to a signed-in session, as the type it was stored with', async () => {
    const sent = await request();
    expect(sent.status).toBe(200);
    expect(sent.headers['content-type']).toBe('image/jpeg');
    expect(sent.headers['content-length']).toBe(BYTES.length);
    expect(sent.headers['x-content-type-options']).toBe('nosniff');
    expect(sent.headers['referrer-policy']).toBe('no-referrer');
    expect(sent.headers['etag']).toBe(`"${DIGEST}"`);
    // Kept by the device, but asked about before each use, so a rejection or a replacement takes effect at once.
    expect(sent.headers['cache-control']).toBe('private, no-cache');
    expect(sent.body.equals(BYTES)).toBe(true);
  });

  it('answers a repeat visit with nothing but 304, and a HEAD with the headers alone', async () => {
    expect((await request({ headers: { 'if-none-match': `"${DIGEST}"` } })).status).toBe(304);
    const head = await request({ method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.body.length).toBe(0);
  });

  it.each([
    ['nobody signed in', { signedIn: false }],
    ['a digest no approved backdrop has', { digest: 'cd'.repeat(32) }],
    ['a digest that is not a digest', { digest: '../../etc/passwd' }],
    ['a stored size that is not the file’s size', { size: BYTES.length + 1 }],
  ])('is not found for %s, and says nothing more', async (_name, options) => {
    const sent = await request(options);
    expect(sent.status).toBe(404);
    expect(sent.headers['cache-control']).toBe('private, no-store');
    expect(sent.body.equals(BYTES)).toBe(false);
  });
});
