import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { assertOutsideTransaction } from '../../../../infrastructure/postgres/transaction-marker.js';
import { consumeCutroomDispatchPermit, type CutroomDispatchPermit } from '../../../../reasoning/public.js';

export type CutroomSubmission =
  | { readonly kind: 'held'; readonly code: 'disabled' | 'permit' }
  | {
      readonly kind: 'observed';
      readonly dispatchId: string;
      readonly requestId: string;
      readonly runId: string | null;
      readonly outcome: 'pending' | 'unknown';
      readonly evidenceSha256: string;
    };
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const id = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value);
async function parser(file: 'responses' | 'errors', name: string): Promise<z.ZodType> {
  const source = import.meta.url.endsWith('.ts');
  const location = new URL(source ? `./wire-v1/${file}.ts` : `./wire-runtime/${file}.js`, import.meta.url).href;
  const loaded = (await import(location)) as Record<string, z.ZodType>;
  if (!loaded[name]) throw new Error('CUTROOM_SUBMIT_PROTOCOL');
  return loaded[name];
}
function bounded(value: unknown): boolean {
  const stack = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const item = stack.pop()!;
    if (++nodes > 12000 || item.depth > 12) return false;
    if (item.value !== null && typeof item.value === 'object') {
      const children = Array.isArray(item.value) ? item.value : Object.values(item.value);
      if (nodes + children.length + stack.length > 12000) return false;
      for (const child of children) stack.push({ value: child, depth: item.depth + 1 });
    }
  }
  return true;
}

/** Exactly one fixed POST with protected, already compiled bytes. A consumed permit is never
 * returned, even on timeout/refusal/protocol/COMMIT uncertainty. No resume/cancel/retry route. */
export function makeCutroomSubmitClient(settings: { readonly enabled?: boolean; readonly origin?: string } = {}) {
  const enabled = settings.enabled === true;
  let origin: URL | undefined;
  try {
    const value = new URL(settings.origin ?? '');
    if (
      value.protocol === 'http:' &&
      ['127.0.0.1', '[::1]'].includes(value.hostname) &&
      !value.username &&
      !value.password &&
      value.pathname === '/' &&
      !value.search &&
      !value.hash
    )
      origin = value;
  } catch {
    /* Invalid configuration confers no transport authority. */
  }
  return {
    async submit(permit: CutroomDispatchPermit): Promise<CutroomSubmission> {
      if (!enabled || !origin) return { kind: 'held', code: 'disabled' };
      assertOutsideTransaction('cutroom.submit');
      const record = consumeCutroomDispatchPermit(permit);
      if (!record) return { kind: 'held', code: 'permit' };
      let requestId: string;
      try {
        if (Buffer.byteLength(record.requestUtf8) > 100000 || hash(record.requestUtf8) !== record.requestSha256)
          return { kind: 'held', code: 'permit' };
        const request = JSON.parse(record.requestUtf8) as { requestId?: unknown };
        if (!id(request.requestId)) return { kind: 'held', code: 'permit' };
        requestId = request.requestId;
      } catch {
        return { kind: 'held', code: 'permit' };
      }
      const observation = (code: string, runId: string | null = null, accepted = false): CutroomSubmission => ({
        kind: 'observed',
        dispatchId: record.dispatchId,
        requestId,
        runId,
        outcome: accepted ? 'pending' : 'unknown',
        evidenceSha256: hash(
          JSON.stringify(['cutroom-submit.v1', record.dispatchId, record.requestSha256, code, runId]),
        ),
      });
      const controller = new AbortController();
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let rejectDeadline!: (error: Error) => void;
      const deadline = new Promise<never>((_, reject) => {
        rejectDeadline = reject;
      });
      const timer = setTimeout(() => {
        controller.abort();
        rejectDeadline(new Error('CUTROOM_SUBMIT_DEADLINE'));
      }, 5000);
      try {
        const response = await Promise.race([
          // eslint-disable-next-line no-restricted-globals -- Fixed loopback one-POST adapter; only C1's live single-use permit can reach it.
          fetch(new URL('/v1/runs', origin), {
            method: 'POST',
            body: record.requestUtf8,
            redirect: 'error',
            signal: controller.signal,
            headers: { 'content-type': 'application/json' },
          }),
          deadline,
        ]);
        if (
          ![202, 409, 422, 500].includes(response.status) ||
          !response.headers.get('content-type')?.includes('application/json') ||
          !response.body
        )
          return observation('protocol');
        reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        for (;;) {
          const item = await Promise.race([reader.read(), deadline]);
          if (item.done) break;
          bytes += item.value.byteLength;
          if (bytes > 262144) return observation('bounds');
          chunks.push(item.value);
        }
        const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
        if (!bounded(raw)) return observation('bounds');
        if (response.status === 500) {
          (await parser('errors', 'ErrorResponse')).parse(raw);
          return observation('server');
        }
        const value = (await parser('responses', 'SubmitResponse')).parse(raw) as {
          outcome: 'accepted' | 'refused';
          requestId?: string;
          runId?: string;
          reason?: string;
        };
        if (value.outcome === 'accepted')
          return response.status === 202 && value.requestId === requestId && id(value.runId)
            ? observation('accepted', value.runId, true)
            : observation('protocol');
        const expectedStatus = value.reason === 'conflict' ? 409 : 422;
        return response.status === expectedStatus && (value.requestId === undefined || value.requestId === requestId)
          ? observation(`refused_${value.reason}`)
          : observation('protocol');
      } catch {
        return observation('unknown');
      } finally {
        clearTimeout(timer);
        controller.abort();
        // Cancellation is best effort: a stalled body cannot extend the finite return deadline.
        if (reader) void reader.cancel().catch(() => undefined);
      }
    },
  };
}
