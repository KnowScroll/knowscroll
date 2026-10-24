import { assertOutsideTransaction } from '../../../../infrastructure/postgres/transaction-marker.js';
import type { EngineRecordFacts, RunResultFacts, RunStatusFacts } from '../../domain/reel/chain.js';
import type { EngineRun, EngineSubmit, ReelEngine } from '../../application/reel/ports.js';
import { wireSchema } from './wire.js';

const MAX_BODY_BYTES = 262144;
const REQUEST_TIMEOUT_MS = 5000;
const PROGRESS_LINES = 6;

interface Reply {
  readonly status: number;
  readonly body: unknown;
}

/** Cutroom only ever listens on loopback, over plain HTTP, with no credentials (CF-61). */
function loopbackOrigin(value: string): URL {
  const origin = new URL(value);
  if (
    origin.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(origin.hostname) ||
    origin.username !== '' ||
    origin.password !== '' ||
    origin.pathname !== '/' ||
    origin.search !== '' ||
    origin.hash !== ''
  )
    throw new Error('CUTROOM_ORIGIN_NOT_LOOPBACK');
  return origin;
}

async function readBounded(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (reader === undefined) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(part.value);
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown;
}

/** One bounded HTTP call. `undefined` when the exchange failed in any way: the caller decides what that means. */
async function exchange(origin: URL, method: 'GET' | 'POST', path: string, body?: string): Promise<Reply | undefined> {
  assertOutsideTransaction('cutroom.reel');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    // eslint-disable-next-line no-restricted-globals -- Reviewed loopback Cutroom adapter (CF-60): fixed routes, no redirects, bounded body, never a model or provider API.
    const response = await fetch(new URL(path, origin), {
      method,
      redirect: 'error',
      signal: controller.signal,
      ...(body === undefined ? {} : { body, headers: { 'content-type': 'application/json' } }),
    });
    if (!response.headers.get('content-type')?.includes('application/json')) return undefined;
    return { status: response.status, body: await readBounded(response) };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

async function parsed<T>(file: 'responses' | 'record' | 'ready', name: string, value: unknown): Promise<T | undefined> {
  const result = (await wireSchema(file, name)).safeParse(value);
  return result.success ? (result.data as T) : undefined;
}

const statusOf = (wire: RunStatusFacts): RunStatusFacts => ({
  runId: wire.runId,
  requestId: wire.requestId,
  state: wire.state,
  resumes: wire.resumes,
  resumedBy: wire.resumedBy,
});

type WireResult = Omit<RunResultFacts, 'videoPath'> & { readonly video?: { readonly path: string } };

function resultOf(wire: WireResult): RunResultFacts {
  return {
    runId: wire.runId,
    requestId: wire.requestId,
    status: wire.status,
    until: wire.until,
    costCents: wire.costCents,
    estimateCents: wire.estimateCents,
    reason: wire.reason,
    limit: wire.limit,
    rule: wire.rule,
    step: wire.step,
    detail: wire.detail,
    stills: wire.stills?.map((still) => ({ pictureId: still.pictureId, shotId: still.shotId })),
    videoPath: wire.video?.path,
    degradations: wire.degradations?.map((entry) => ({ shotId: entry.shotId, reason: entry.reason })),
  };
}

type WireEvent =
  | { readonly type: 'run.accepted' }
  | { readonly type: 'stage.started' | 'stage.finished'; readonly stage: string }
  | { readonly type: 'verdict'; readonly gate: string; readonly outcome: string; readonly shotId?: string }
  | { readonly type: 'degraded'; readonly shotId: string }
  | { readonly type: 'run.finished'; readonly status: string };

function describeEvent(event: WireEvent): string {
  switch (event.type) {
    case 'run.accepted':
      return 'accepted';
    case 'stage.started':
    case 'stage.finished':
      return `${event.type} ${event.stage}`;
    case 'verdict':
      return `gate ${event.gate} ${event.outcome}${event.shotId === undefined ? '' : ` (${event.shotId})`}`;
    case 'degraded':
      return `degraded ${event.shotId}`;
    case 'run.finished':
      return `finished ${event.status}`;
  }
}

/**
 * Cutroom over its published HTTP contract (CF-60, CF-61). Fixed routes, loopback only, bounded
 * replies parsed by the vendored wire schemas. `submit` makes exactly one POST and never retries
 * it; every other call is a read. A reply that does not parse is treated as no answer.
 */
export function cutroomEngine(settings: { readonly origin: string }): ReelEngine {
  const origin = loopbackOrigin(settings.origin);
  const id = (value: string) => encodeURIComponent(value);

  async function findRun(path: string): Promise<EngineRun> {
    const reply = await exchange(origin, 'GET', path);
    if (reply === undefined) return { kind: 'unreachable' };
    if (reply.status === 404) return { kind: 'absent' };
    const status =
      reply.status === 200 ? await parsed<RunStatusFacts>('responses', 'RunStatus', reply.body) : undefined;
    return status === undefined ? { kind: 'unreachable' } : { kind: 'found', status: statusOf(status) };
  }

  async function finished<T>(
    runId: string,
    route: 'result' | 'record',
    file: 'responses' | 'record',
    name: string,
  ): Promise<{ readonly kind: 'finished'; readonly value: T } | { readonly kind: 'running' | 'unreachable' }> {
    const reply = await exchange(origin, 'GET', `/v1/runs/${id(runId)}/${route}`);
    if (reply === undefined) return { kind: 'unreachable' };
    if (reply.status === 409) return { kind: 'running' };
    const value = reply.status === 200 ? await parsed<T>(file, name, reply.body) : undefined;
    return value === undefined ? { kind: 'unreachable' } : { kind: 'finished', value };
  }

  return {
    async ready() {
      const reply = await exchange(origin, 'GET', '/v1/ready');
      const answer =
        reply?.status === 200 ? await parsed<{ ready: boolean }>('ready', 'ReadyResponse', reply.body) : undefined;
      return answer?.ready === true;
    },

    async submit(requestUtf8): Promise<EngineSubmit> {
      const { requestId } = JSON.parse(requestUtf8) as { requestId: string };
      const reply = await exchange(origin, 'POST', '/v1/runs', requestUtf8);
      if (reply === undefined) return { kind: 'unknown', code: 'no_answer' };
      const answer = await parsed<
        | { outcome: 'accepted'; requestId: string; runId: string; replayed: boolean }
        | { outcome: 'refused'; reason: string }
      >('responses', 'SubmitResponse', reply.body);
      if (answer === undefined) return { kind: 'unknown', code: 'unreadable_answer' };
      if (answer.outcome === 'accepted')
        return reply.status === 202 && answer.requestId === requestId
          ? { kind: 'accepted', runId: answer.runId, replayed: answer.replayed }
          : { kind: 'unknown', code: 'unexpected_answer' };
      return reply.status === 409 || reply.status === 422
        ? { kind: 'refused', reason: answer.reason }
        : { kind: 'unknown', code: 'unexpected_answer' };
    },

    lookup: (requestId) => findRun(`/v1/runs?requestId=${id(requestId)}`),
    status: (runId) => findRun(`/v1/runs/${id(runId)}`),

    async result(runId) {
      const answer = await finished<WireResult>(runId, 'result', 'responses', 'RunResult');
      return answer.kind === 'finished' ? { kind: 'finished', result: resultOf(answer.value) } : answer;
    },

    async record(runId) {
      const answer = await finished<EngineRecordFacts>(runId, 'record', 'record', 'RunRecord');
      return answer.kind === 'finished' ? { kind: 'finished', record: answer.value } : answer;
    },

    async progress(runId) {
      const reply = await exchange(origin, 'GET', `/v1/runs/${id(runId)}/events?since=0`);
      const page =
        reply?.status === 200
          ? await parsed<{ events: readonly WireEvent[] }>('responses', 'EventsPage', reply.body)
          : undefined;
      return page === undefined ? [] : page.events.slice(-PROGRESS_LINES).map(describeEvent);
    },
  };
}
