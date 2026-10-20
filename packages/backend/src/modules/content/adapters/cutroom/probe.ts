import { execFile } from 'node:child_process';
import { open } from 'node:fs/promises';
import { promisify } from 'node:util';
import { z } from 'zod';
const probeSchema = z.object({
  format: z.object({
    format_name: z.string(),
    duration: z.string(),
    tags: z.record(z.string(), z.string()).optional(),
  }),
  streams: z.array(
    z.object({
      codec_type: z.string(),
      codec_name: z.string(),
      width: z.number().optional(),
      height: z.number().optional(),
      avg_frame_rate: z.string().optional(),
      sample_rate: z.string().optional(),
      channels: z.number().optional(),
    }),
  ),
});
export async function probeReel(path: string, binary = '/usr/bin/ffprobe') {
  const { stdout } = await promisify(execFile)(
    binary,
    ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', path],
    { timeout: 15000, maxBuffer: 131072 },
  );
  const probe = probeSchema.parse(JSON.parse(stdout));
  const video = probe.streams.filter((stream) => stream.codec_type === 'video');
  const audio = probe.streams.filter((stream) => stream.codec_type === 'audio');
  const v = video[0];
  const a = audio[0];
  const durationMs = Math.round(Number(probe.format.duration) * 1000);
  const [numerator, denominator] = (v?.avg_frame_rate ?? '').split('/').map(Number);
  const fps = (numerator ?? 0) / (denominator ?? 0);
  if (
    probe.format.tags?.['major_brand'] === 'qt  ' ||
    !probe.format.format_name.split(',').includes('mp4') ||
    video.length !== 1 ||
    audio.length !== 1 ||
    probe.streams.length !== 2 ||
    v?.codec_name !== 'h264' ||
    a?.codec_name !== 'aac' ||
    v.width === undefined ||
    v.height === undefined ||
    Math.abs(v.width / v.height / (9 / 16) - 1) > 0.02 ||
    Math.abs(fps - 24) > 0.001 ||
    a.sample_rate !== '48000' ||
    a.channels !== 2 ||
    !Number.isFinite(durationMs) ||
    durationMs < 20000 ||
    durationMs > 60000
  )
    throw new Error('media_profile_refused');
  const file = await open(path, 'r');
  let faststart = false;
  try {
    const size = (await file.stat()).size;
    let offset = 0;
    while (offset + 8 <= size) {
      const header = Buffer.alloc(16);
      await file.read(header, 0, Math.min(16, size - offset), offset);
      let length = header.readUInt32BE(0);
      const type = header.toString('ascii', 4, 8);
      if (length === 1) {
        const wide = header.readBigUInt64BE(8);
        if (wide > BigInt(Number.MAX_SAFE_INTEGER)) break;
        length = Number(wide);
      }
      if (length < 8 || offset + length > size) break;
      if (type === 'moov') {
        faststart = true;
        break;
      }
      if (type === 'mdat') break;
      offset += length;
    }
  } finally {
    await file.close();
  }
  if (!faststart) throw new Error('media_faststart_refused');
  return {
    v: 1,
    durationMs,
    width: v.width,
    height: v.height,
    fps: 24,
    audioHz: 48000,
    channels: 2,
    faststart: true,
  } as const;
}
