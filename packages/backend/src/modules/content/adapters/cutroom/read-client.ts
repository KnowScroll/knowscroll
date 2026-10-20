import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { z } from 'zod';
import { assertOutsideTransaction } from '../../../../infrastructure/postgres/transaction-marker.js';
import { MAX_MEDIA_BYTES } from '../../../../infrastructure/media-store/index.js';

export interface RunStatus {
  contractVersion: 1;
  runId: string;
  requestId: string;
  state: 'running' | 'finished';
  lastSeq: number;
  resumes?: string;
  resumedBy?: string;
}
export interface VideoResult {
  contractVersion: 1;
  runId: string;
  requestId: string;
  costCents: number;
  status: 'completed';
  until: 'video';
  estimateCents: number;
  stills: { pictureId: string; shotId: string; path: string }[];
  video: { path: string };
  degradations: { shotId: string; reason: string }[];
}
export interface EngineRecord {
  contractVersion: 1;
  runId: string;
  pictures: {
    pictureId: string;
    shotId: string;
    chosen: boolean;
    keptFrom?: string;
    observationId?: string;
    reconciliationId?: string;
    checks: { gate: string; step?: string; outcome: string }[];
  }[];
  takes: {
    takeId: string;
    shotId: string;
    number: number;
    used: boolean;
    keptFrom?: string;
    observationId?: string;
    reconciliationId?: string;
    checks: { gate: string; outcome: string }[];
  }[];
  degradations: { shotId: string; reason: string }[];
}
export class CutroomReadRefusal extends Error {
  constructor(
    readonly code: 'unreachable' | 'protocol' | 'not_final' | 'not_video' | 'artifact_unsafe' | 'artifact_size',
  ) {
    super(code);
  }
}
interface Parser {
  parse(value: unknown): unknown;
}
async function parser(file: string, name: string): Promise<Parser> {
  const source = import.meta.url.endsWith('.ts');
  const location = new URL(source ? `./wire-v1/${file}.ts` : `./wire-runtime/${file}.js`, import.meta.url).href;
  const loaded = (await import(location)) as Record<string, z.ZodType>;
  const schema = loaded[name];
  if (schema === undefined) throw new CutroomReadRefusal('protocol');
  return schema;
}
/** GET-only client: no commission, resume, cancel, events or general request escape hatch. */
export function cutroomReadClient(settings: { origin: string; artifactRoot: string; timeoutMs?: number }) {
  const origin = new URL(settings.origin);
  if (
    origin.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(origin.hostname) ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  )
    throw new CutroomReadRefusal('protocol');
  async function get(path: string, file: string, name: string): Promise<unknown> {
    assertOutsideTransaction('cutroom.read');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), settings.timeoutMs ?? 5000);
    try {
      // eslint-disable-next-line no-restricted-globals -- Reviewed GET-only loopback Cutroom read adapter, never a model or paid endpoint.
      const response = await fetch(new URL(path, origin), {
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
      });
      if (response.status === 409) throw new CutroomReadRefusal('not_final');
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json'))
        throw new CutroomReadRefusal('protocol');
      if (response.body === null) throw new CutroomReadRefusal('protocol');
      const chunks: Uint8Array[] = [];
      let length = 0;
      for await (const chunk of response.body) {
        length += chunk.length;
        if (length > 262144) {
          controller.abort();
          throw new CutroomReadRefusal('protocol');
        }
        chunks.push(chunk);
      }
      try {
        return (await parser(file, name)).parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        throw new CutroomReadRefusal('protocol');
      }
    } catch (error) {
      if (error instanceof CutroomReadRefusal) throw error;
      throw new CutroomReadRefusal('unreachable');
    } finally {
      clearTimeout(timer);
    }
  }
  const id = (value: string): string => encodeURIComponent(value);
  return {
    ready: () => get('/v1/ready', 'ready', 'ReadyResponse'),
    lookup: (requestId: string) =>
      get(`/v1/runs?requestId=${id(requestId)}`, 'responses', 'RunStatus') as Promise<RunStatus>,
    status: (runId: string) => get(`/v1/runs/${id(runId)}`, 'responses', 'RunStatus') as Promise<RunStatus>,
    async result(runId: string): Promise<VideoResult> {
      const result = (await get(`/v1/runs/${id(runId)}/result`, 'responses', 'RunResult')) as Partial<VideoResult>;
      if (result.status !== 'completed' || result.until !== 'video') throw new CutroomReadRefusal('not_video');
      return result as VideoResult;
    },
    record: (runId: string) => get(`/v1/runs/${id(runId)}/record`, 'record', 'RunRecord') as Promise<EngineRecord>,
    async openArtifact(path: string, runId: string) {
      const root = resolve(settings.artifactRoot);
      const candidate = resolve(path);
      const inside = relative(root, candidate);
      if (
        !isAbsolute(path) ||
        inside.startsWith('..') ||
        isAbsolute(inside) ||
        dirname(inside) !== runId ||
        !/^a[1-9][0-9]*-render\.mp4$/.test(inside.split('/').at(-1) ?? '')
      )
        throw new CutroomReadRefusal('artifact_unsafe');
      if (
        (await realpath(root)) !== root ||
        (await realpath(candidate)) !== candidate ||
        !(await lstat(candidate)).isFile()
      )
        throw new CutroomReadRefusal('artifact_unsafe');
      const handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_MEDIA_BYTES) {
        await handle.close();
        throw new CutroomReadRefusal('artifact_size');
      }
      return { stream: handle.createReadStream(), size: stat.size };
    },
  };
}
