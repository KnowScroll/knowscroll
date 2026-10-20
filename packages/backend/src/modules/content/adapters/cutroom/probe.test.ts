import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { probeReel } from './probe.js';

describe('staged MP4 conformance (generated CI fixture, no provider)', () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'ks-probe-'));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });
  async function generate(name: string, size = '144x256', seconds = '20', codec = 'libx264', faststart = true) {
    const path = join(root, `${name}.mp4`);
    await promisify(execFile)(
      'ffmpeg',
      [
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        `color=c=navy:s=${size}:r=24:d=${seconds}`,
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
        '-c:v',
        codec,
        ...(codec === 'libx264' ? ['-preset', 'ultrafast'] : []),
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-ar',
        '48000',
        '-ac',
        '2',
        ...(faststart ? ['-movflags', '+faststart'] : []),
        '-shortest',
        path,
      ],
      { timeout: 30000, maxBuffer: 131072 },
    );
    return path;
  }
  it('accepts H264/AAC stereo 24fps 48kHz faststart portrait', async () => {
    expect(await probeReel(await generate('valid'))).toMatchObject({
      durationMs: 20000,
      width: 144,
      height: 256,
      faststart: true,
    });
  });
  it.each([
    ['wrong-aspect', '256x144', '20', 'libx264', true],
    ['short', '144x256', '2', 'libx264', true],
    ['wrong-codec', '144x256', '20', 'mpeg4', true],
    ['late-moov', '144x256', '20', 'libx264', false],
  ] as const)('refuses %s', async (name, size, seconds, codec, faststart) => {
    await expect(probeReel(await generate(name, size, seconds, codec, faststart))).rejects.toThrow();
  });
});
