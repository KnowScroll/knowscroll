import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';

/**
 * LABELLED FIXTURE. A stand-in for Cutroom's published HTTP contract (wire v1): the same routes,
 * status codes and strict body shapes, scripted by the test. It makes no model call, no provider
 * call and no spend, and the "videos" it serves are generated colour bars. Nothing here proves
 * anything about the real engine.
 */
export interface FakeRun {
  readonly runId: string;
  readonly requestId: string;
  readonly body: string;
  state: 'running' | 'finished';
  resumes?: string;
  resumedBy?: string;
  result?: Record<string, unknown>;
  record?: Record<string, unknown>;
  events: Record<string, unknown>[];
}

/** What the next POST does. */
export type PostMode =
  | 'accept'
  /** 422: Cutroom refuses the body and makes no run. */
  | 'refuse'
  /** The run is made, then the connection is dropped before the answer: the outcome is unknown. */
  | 'drop_after_run'
  /** The connection is dropped and no run exists: the outcome is unknown, and the run never appears. */
  | 'drop_without_run';

export interface CompletedOptions {
  readonly costCents: number;
  /** Mark a failed check on a used take, so the engine's own record does not attest the Reel. */
  readonly failTake?: boolean;
  /** The engine's record lists a degradation its result does not: the two disagree. */
  readonly mismatchRecord?: boolean;
  readonly resumes?: string;
}

const run = promisify(execFile);

export async function startFakeCutroom(root: string, onPost?: (body: string) => Promise<void>) {
  const artifactRoot = join(root, 'engine');
  await mkdir(artifactRoot, { recursive: true });
  const runs = new Map<string, FakeRun>();
  const posts: string[] = [];
  const gets: string[] = [];
  const state = { ready: true, mode: 'accept' as PostMode };

  const send = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  };
  const newest = (requestId: string): FakeRun | undefined =>
    [...runs.values()].filter((entry) => entry.requestId === requestId).at(-1);
  const status = (entry: FakeRun) => ({
    contractVersion: 1,
    runId: entry.runId,
    requestId: entry.requestId,
    state: entry.state,
    lastSeq: entry.events.length,
    ...(entry.resumes === undefined ? {} : { resumes: entry.resumes }),
    ...(entry.resumedBy === undefined ? {} : { resumedBy: entry.resumedBy }),
  });
  const event = (entry: FakeRun, fields: Record<string, unknown>) => {
    entry.events.push({
      contractVersion: 1,
      runId: entry.runId,
      seq: entry.events.length + 1,
      at: new Date().toISOString(),
      ...fields,
    });
  };

  async function handlePost(request: IncomingMessage, response: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    posts.push(body);
    await onPost?.(body);
    const parsed = JSON.parse(body) as { requestId: string };
    if (state.mode === 'drop_without_run') return request.socket.destroy();
    const known = newest(parsed.requestId);
    if (known !== undefined) {
      if (known.body !== body)
        return send(response, 409, {
          contractVersion: 1,
          outcome: 'refused',
          reason: 'conflict',
          detail: 'different body',
        });
      return send(response, 202, {
        contractVersion: 1,
        outcome: 'accepted',
        requestId: parsed.requestId,
        runId: known.runId,
        replayed: true,
      });
    }
    if (state.mode === 'refuse')
      return send(response, 422, {
        contractVersion: 1,
        outcome: 'refused',
        requestId: parsed.requestId,
        reason: 'invalid',
        detail: 'fixture refusal',
      });
    const entry: FakeRun = {
      runId: randomUUID(),
      requestId: parsed.requestId,
      body,
      state: 'running',
      events: [],
    };
    event(entry, { type: 'run.accepted' });
    event(entry, { type: 'stage.started', stage: 'plan' });
    runs.set(entry.runId, entry);
    if (state.mode === 'drop_after_run') return request.socket.destroy();
    return send(response, 202, {
      contractVersion: 1,
      outcome: 'accepted',
      requestId: parsed.requestId,
      runId: entry.runId,
      replayed: false,
    });
  }

  function handleGet(url: URL, response: ServerResponse) {
    gets.push(url.pathname + url.search);
    if (url.pathname === '/v1/ready')
      return state.ready
        ? send(response, 200, { contractVersion: 1, ready: true })
        : send(response, 503, { contractVersion: 1, ready: false });
    if (url.pathname === '/v1/runs') {
      const found = newest(url.searchParams.get('requestId') ?? '');
      return found === undefined
        ? send(response, 404, { contractVersion: 1, error: 'not-found', detail: 'no run' })
        : send(response, 200, status(found));
    }
    const match = /^\/v1\/runs\/([^/]+)(?:\/(result|record|events))?$/.exec(url.pathname);
    const entry = match?.[1] === undefined ? undefined : runs.get(match[1]);
    if (entry === undefined) return send(response, 404, { contractVersion: 1, error: 'not-found', detail: 'no run' });
    switch (match?.[2]) {
      case undefined:
        return send(response, 200, status(entry));
      case 'events':
        return send(response, 200, {
          contractVersion: 1,
          runId: entry.runId,
          events: entry.events,
          nextSince: entry.events.length,
        });
      case 'result':
        return entry.result === undefined ? send(response, 409, status(entry)) : send(response, 200, entry.result);
      default:
        return entry.record === undefined ? send(response, 409, status(entry)) : send(response, 200, entry.record);
    }
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture.invalid');
    if (request.method === 'POST' && url.pathname === '/v1/runs') {
      void handlePost(request, response);
      return;
    }
    if (request.method === 'GET') return handleGet(url, response);
    send(response, 405, { contractVersion: 1, error: 'invalid', detail: 'method' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fixture_bind_failed');

  async function renderVideo(path: string, color: string): Promise<void> {
    await run(
      'ffmpeg',
      [
        ...['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=144x256:r=24:d=20`],
        ...['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=20'],
        ...[
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
        ],
        ...['-movflags', '+faststart', '-metadata', 'title=KnowScroll CI fixture', '-shortest', path],
      ],
      { timeout: 60000, maxBuffer: 131072 },
    );
  }

  const requestFor = (requestId: string): FakeRun => {
    const found = newest(requestId);
    if (found === undefined) throw new Error('fixture_no_such_request');
    return found;
  };

  return {
    origin: `http://127.0.0.1:${address.port}`,
    artifactRoot,
    posts,
    gets,
    runs,
    setReady: (ready: boolean) => {
      state.ready = ready;
    },
    setPostMode: (mode: PostMode) => {
      state.mode = mode;
    },
    runOf: requestFor,

    /** Finishes the newest run of a request as a completed plan. */
    finishPlan(requestId: string, estimateCents: number) {
      const entry = requestFor(requestId);
      entry.state = 'finished';
      entry.result = {
        contractVersion: 1,
        runId: entry.runId,
        requestId,
        costCents: 0,
        status: 'completed',
        until: 'plan',
        estimateCents,
      };
      event(entry, { type: 'run.finished', status: 'completed' });
      return entry;
    },

    /** Finishes the newest run as a completed video with a real MP4 and an attesting record. */
    async finishCompleted(requestId: string, options: CompletedOptions): Promise<FakeRun> {
      const entry = requestFor(requestId);
      const folder = join(artifactRoot, entry.runId);
      await mkdir(folder, { recursive: true });
      const video = join(folder, 'a1-render.mp4');
      await renderVideo(video, `0x${entry.runId.slice(0, 6)}`);
      const shots = [1, 3, 5];
      const kept = options.resumes === undefined ? {} : { keptFrom: options.resumes };
      entry.state = 'finished';
      entry.result = {
        contractVersion: 1,
        runId: entry.runId,
        requestId,
        costCents: options.costCents,
        status: 'completed',
        until: 'video',
        estimateCents: options.costCents - 8,
        stills: shots.map((shot) => ({
          pictureId: `picture-${shot}`,
          shotId: `shot-${shot}`,
          path: join(folder, `still-${shot}.jpg`),
        })),
        video: { path: video },
        degradations: [],
      };
      entry.record = {
        contractVersion: 1,
        runId: entry.runId,
        pictures: shots.map((shot) => ({
          pictureId: `picture-${shot}`,
          shotId: `shot-${shot}`,
          chosen: true,
          ...kept,
          checks: ['technical', 'text', 'witness', 'reconcile'].map((step) => ({ gate: '1', step, outcome: 'accept' })),
        })),
        takes: Array.from({ length: 6 }, (_, index) => ({
          takeId: `take-${index + 1}`,
          shotId: `shot-${index + 1}`,
          number: 1,
          used: true,
          ...kept,
          checks: ['2', '3', '4', '5'].map((gate) => ({
            gate,
            outcome: options.failTake === true && index === 0 && gate === '4' ? 'fail' : 'accept',
          })),
        })),
        degradations: options.mismatchRecord === true ? [{ shotId: 'shot-2', reason: 'fixture mismatch' }] : [],
      };
      event(entry, { type: 'run.finished', status: 'completed' });
      return entry;
    },

    /** Finishes the newest run as stopped by a rule. */
    finishStopped(requestId: string, costCents: number) {
      const entry = requestFor(requestId);
      entry.state = 'finished';
      entry.result = {
        contractVersion: 1,
        runId: entry.runId,
        requestId,
        costCents,
        status: 'stopped',
        reason: 'rule',
        rule: 'gate-5',
        step: 'video',
        detail: 'shot 3 did not show the scene (see https://example.invalid/clip?token=secret and /srv/x/y/z.mp4)',
      };
      event(entry, { type: 'run.finished', status: 'stopped' });
      return entry;
    },

    /** The original run fails and Cutroom itself starts the continuation (CF-61). */
    failAndResume(requestId: string, costCents: number): FakeRun {
      const parent = requestFor(requestId);
      parent.state = 'finished';
      parent.result = {
        contractVersion: 1,
        runId: parent.runId,
        requestId,
        costCents,
        status: 'failed',
        detail: 'provider unavailable',
      };
      event(parent, { type: 'run.finished', status: 'failed' });
      const child: FakeRun = {
        runId: randomUUID(),
        requestId,
        body: parent.body,
        state: 'running',
        resumes: parent.runId,
        events: [],
      };
      event(child, { type: 'run.accepted' });
      parent.resumedBy = child.runId;
      runs.set(child.runId, child);
      return child;
    },

    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

export type FakeCutroom = Awaited<ReturnType<typeof startFakeCutroom>>;
