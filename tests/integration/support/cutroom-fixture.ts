import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

export const fixtureRunId = '6a12af96-51ce-4e08-8e29-d8bc498c4c53';
/** CI/local fixture only: generates labelled synthetic bytes, never calls an engine/provider. */
export async function cutroomFixture(root: string, options: { ffmpeg?: string } = {}) {
  const artifactRoot = join(root, 'engine');
  const mediaRoot = join(root, 'media');
  const folder = join(artifactRoot, fixtureRunId);
  await mkdir(folder, { recursive: true });
  await mkdir(mediaRoot, { recursive: true });
  const path = join(folder, 'a1-render.mp4');
  await promisify(execFile)(
    options.ffmpeg ?? 'ffmpeg',
    [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=navy:s=144x256:r=24:d=20',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=20',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-ac',
      '2',
      '-ar',
      '48000',
      '-movflags',
      '+faststart',
      '-metadata',
      'title=KnowScroll CI fixture',
      '-shortest',
      path,
    ],
    { timeout: 30000, maxBuffer: 131072 },
  );
  const status = {
    contractVersion: 1,
    runId: fixtureRunId,
    requestId: 'fixture-read-only-no-spend',
    state: 'finished',
    lastSeq: 1,
  };
  // Synthetic metadata with the real greenhouse topology: three pictured shots, six used takes.
  // Other shots are permitted text-to-video by the pinned engine; the wire has no mode field.
  const picturedShots = [1, 3, 5];
  const result = {
    contractVersion: 1,
    runId: fixtureRunId,
    requestId: status.requestId,
    status: 'completed',
    until: 'video',
    costCents: 0,
    estimateCents: 0,
    stills: picturedShots.map((shot) => ({
      pictureId: `fixture-picture-${shot}`,
      shotId: `shot-${shot}`,
      path: join(folder, `fixture-${shot}.jpg`),
    })),
    video: { path },
    degradations: [],
  };
  const record = {
    contractVersion: 1,
    runId: fixtureRunId,
    pictures: picturedShots.map((shot) => ({
      pictureId: `fixture-picture-${shot}`,
      shotId: `shot-${shot}`,
      chosen: true,
      checks: ['technical', 'text', 'witness', 'reconcile'].map((step) => ({ gate: '1', step, outcome: 'accept' })),
    })),
    takes: Array.from({ length: 6 }, (_, index) => ({
      takeId: `fixture-take-${index + 1}`,
      shotId: `shot-${index + 1}`,
      number: 1,
      used: true,
      checks: ['2', '3', '4', '5'].map((gate) => ({ gate, outcome: 'accept' })),
    })),
    degradations: [],
  };
  const ready = { contractVersion: 1, ready: true };
  const methods: string[] = [];
  const server = createServer((request, response) => {
    methods.push(request.method ?? '');
    response.setHeader('Content-Type', 'application/json');
    if (request.method !== 'GET') {
      response.writeHead(405).end('{}');
      return;
    }
    const endpoint = new URL(request.url ?? '', 'http://fixture.invalid').pathname;
    const body =
      endpoint === '/v1/ready'
        ? ready
        : endpoint.endsWith('/result')
          ? result
          : endpoint.endsWith('/record')
            ? record
            : status;
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture_bind_failed');
  return {
    artifactRoot,
    ready,
    mediaRoot,
    path,
    status,
    result,
    record,
    methods,
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
