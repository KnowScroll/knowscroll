import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { assertOutsideTransaction } from '../../../../infrastructure/postgres/transaction-marker.js';
import {
  CUTROOM_CHAIN_COLLECTION_LIMITS as limits,
  CUTROOM_CHAIN_LIMITS as shapeLimits,
  CUTROOM_CHAIN_UPSTREAM_REVISION,
  CutroomChainInputSchema,
  CutroomChainStatusSnapshotSchema,
  CutroomChainResultSnapshotSchema,
  CutroomChainRecordSnapshotSchema,
  type CutroomChainCollector,
  type CutroomChainCollectorSettings,
  type CutroomChainCollection,
  type CutroomChainInput,
} from '../../production/commission-contracts.js';
import { validatePinnedCutroomChain } from '../../production/commission-chain.js';
import type { EngineRecord, VideoResult } from './read-client.js';

type Failure = Exclude<CutroomChainCollection, { kind: 'observed' }>;
class CollectionRefusal extends Error {
  constructor(readonly result: Failure) {
    super('cutroom_collection_refused');
  }
}
const refuse = (code: Extract<Failure, { kind: 'unknown' }>['code']): never => {
  throw new CollectionRefusal({ kind: 'unknown', code });
};
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
/** Only fields used by the projection. The FULL canonical vendor schema parses first. */
type Terminal = Pick<VideoResult, 'contractVersion' | 'runId' | 'requestId' | 'costCents'> & {
  readonly status: 'completed' | 'refused' | 'stopped' | 'failed' | 'cancelled';
  readonly until?: 'plan' | 'stills' | 'video';
  readonly stills?: VideoResult['stills'];
  readonly degradations?: VideoResult['degradations'];
};
async function wireParser(file: 'ready' | 'responses' | 'record', name: string): Promise<z.ZodType> {
  const source = import.meta.url.endsWith('.ts');
  const location = new URL(source ? `./wire-v1/${file}.ts` : `./wire-runtime/${file}.js`, import.meta.url).href;
  const loaded = (await import(location)) as Record<string, z.ZodType>;
  const schema = loaded[name];
  if (!schema) return refuse('protocol');
  return schema;
}
/** Bound raw parse trees BEFORE recursive canonical wire validation. No rejected values escape. */
function bounded(value: unknown): boolean {
  const stack = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const item = stack.pop()!;
    if (++nodes > shapeLimits.nodesPerDocument || item.depth > shapeLimits.depth) return false;
    if (item.value !== null && typeof item.value === 'object') {
      const children = Array.isArray(item.value) ? item.value : Object.values(item.value);
      if (nodes + children.length + stack.length > shapeLimits.nodesPerDocument) return false;
      for (const child of children) stack.push({ value: child, depth: item.depth + 1 });
    }
  }
  return true;
}
function serialized(value: unknown, schema: z.ZodType): string {
  const parsed = schema.safeParse(value);
  if (!parsed.success) return refuse('protocol');
  const utf8 = JSON.stringify(parsed.data);
  if (Buffer.byteLength(utf8) > shapeLimits.documentBytes) return refuse('bounds');
  return utf8;
}
function degradation(value: { shotId: string; reason: string }) {
  return { shotId: value.shotId, reasonSha256: hash(value.reason) };
}
function terminalProjection(v: Terminal): string {
  const common = {
    contractVersion: v.contractVersion,
    runId: v.runId,
    requestId: v.requestId,
    costCents: v.costCents,
    status: v.status,
  };
  if (v.status !== 'completed') return serialized(common, CutroomChainResultSnapshotSchema);
  return serialized(
    {
      ...common,
      until: v.until,
      ...(v.until === 'plan'
        ? {}
        : {
            stills: v.stills?.map((s) => ({ pictureId: s.pictureId, shotId: s.shotId })),
            degradations: v.degradations?.map(degradation),
          }),
    },
    CutroomChainResultSnapshotSchema,
  );
}
function recordProjection(v: EngineRecord): string {
  return serialized(
    {
      contractVersion: v.contractVersion,
      runId: v.runId,
      pictures: v.pictures.map((p) => ({
        pictureId: p.pictureId,
        shotId: p.shotId,
        chosen: p.chosen,
        ...(p.keptFrom === undefined ? {} : { keptFrom: p.keptFrom }),
        ...(p.observationId === undefined ? {} : { observationId: p.observationId }),
        ...(p.reconciliationId === undefined ? {} : { reconciliationId: p.reconciliationId }),
        checks: p.checks.map((c) => ({
          gate: c.gate,
          ...(c.step === undefined ? {} : { step: c.step }),
          outcome: c.outcome,
        })),
      })),
      takes: v.takes.map((p) => ({
        takeId: p.takeId,
        shotId: p.shotId,
        number: p.number,
        used: p.used,
        ...(p.keptFrom === undefined ? {} : { keptFrom: p.keptFrom }),
        ...(p.observationId === undefined ? {} : { observationId: p.observationId }),
        ...(p.reconciliationId === undefined ? {} : { reconciliationId: p.reconciliationId }),
        checks: p.checks.map((c) => ({ gate: c.gate, outcome: c.outcome })),
      })),
      degradations: v.degradations.map(degradation),
    },
    CutroomChainRecordSnapshotSchema,
  );
}
function originOf(value: string | undefined): URL | undefined {
  try {
    if (!value || value.length > 128) return undefined;
    const origin = new URL(value);
    return origin.protocol === 'http:' &&
      ['127.0.0.1', '[::1]'].includes(origin.hostname) &&
      !origin.username &&
      !origin.password &&
      origin.pathname === '/' &&
      !origin.search &&
      !origin.hash
      ? origin
      : undefined;
  } catch {
    return undefined;
  }
}
/** GET-only and inert by default. Supplied profile expectations are NOT deployed-service proof.
 * Raw wire bodies are private transient input; return only finite reports/digests/counters. */
export function makeCutroomChainCollector(settings: CutroomChainCollectorSettings = {}): CutroomChainCollector {
  // Capture trusted composition settings, never a per-request origin/profile override.
  const enabled = settings.enabled === true;
  const origin = originOf(settings.origin);
  const profile = settings.profile ? { ...settings.profile } : undefined;
  const clock = settings.now ?? Date.now;
  return {
    async collect(expected): Promise<CutroomChainCollection> {
      if (!enabled) return { kind: 'unavailable', code: 'disabled' };
      try {
        const start = clock();
        if (
          !origin ||
          !profile ||
          profile.upstreamRevision !== CUTROOM_CHAIN_UPSTREAM_REVISION ||
          !/^[0-9a-f]{64}$/.test(profile.soleWriterEvidenceSha256) ||
          !Number.isSafeInteger(profile.observedAtMs) ||
          !Number.isSafeInteger(profile.expiresAtMs) ||
          !Number.isSafeInteger(start) ||
          profile.observedAtMs < 0 ||
          profile.observedAtMs > start ||
          profile.expiresAtMs <= start ||
          profile.expiresAtMs - profile.observedAtMs > shapeLimits.freshnessMs ||
          start > Number.MAX_SAFE_INTEGER - limits.collectionTimeoutMs
        )
          return { kind: 'unavailable', code: 'profile' };
        // Expected fields are flat scalar metadata; refuse an oversized envelope before Zod.
        if (
          !expected ||
          typeof expected !== 'object' ||
          Object.keys(expected).length > 10 ||
          Object.values(expected).some((v) => typeof v === 'object' || (typeof v === 'string' && v.length > 128))
        )
          return { kind: 'unavailable', code: 'identity' };
        const parsedExpected = CutroomChainInputSchema.shape.expected.safeParse(expected);
        if (
          !parsedExpected.success ||
          parsedExpected.data.requestId !==
            `ks-reel-${parsedExpected.data.scriptSha256.slice(0, 32)}-${parsedExpected.data.take}`
        )
          return { kind: 'unavailable', code: 'identity' };
        const identity = parsedExpected.data;
        let calls = 0,
          responseBytes = 0,
          lastTime = start;
        const evidence: string[] = [];
        function time(): number {
          const now = clock();
          if (
            !Number.isSafeInteger(now) ||
            now < lastTime ||
            now >= profile!.expiresAtMs ||
            now - start >= limits.collectionTimeoutMs
          )
            return refuse('deadline');
          lastTime = now;
          return now;
        }
        async function get<T>(path: string, file: 'ready' | 'responses' | 'record', schemaName: string) {
          assertOutsideTransaction('cutroom.chain.read');
          const before = time();
          if (++calls > limits.calls) return refuse('bounds');
          const controller = new AbortController();
          let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
          let rejectDeadline!: (reason: CollectionRefusal) => void;
          const deadline = new Promise<never>((_resolve, reject) => {
            rejectDeadline = reject;
          });
          const timer = setTimeout(
            () => {
              rejectDeadline(new CollectionRefusal({ kind: 'unknown', code: 'deadline' }));
              controller.abort();
            },
            Math.min(limits.callTimeoutMs, start + limits.collectionTimeoutMs - before, profile!.expiresAtMs - before),
          );
          function withinCall(): number {
            const at = time();
            if (controller.signal.aborted || at - before >= limits.callTimeoutMs) return refuse('deadline');
            return at;
          }
          try {
            const response = await Promise.race([
              // eslint-disable-next-line no-restricted-globals -- Fixed GET-only loopback Cutroom collector, no model/paid endpoint or arbitrary request escape hatch.
              fetch(new URL(path, origin), {
                method: 'GET',
                redirect: 'error',
                signal: controller.signal,
              }),
              deadline,
            ]);
            withinCall();
            if (response.status === 409 && (schemaName === 'RunResult' || schemaName === 'RunRecord'))
              throw new CollectionRefusal({ kind: 'pending', code: 'running' });
            if (response.status === 404) return refuse('not_found');
            if (
              (response.status !== 200 && !(schemaName === 'ReadyResponse' && response.status === 503)) ||
              response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json'
            )
              return refuse('protocol');
            if (!response.body) return refuse('protocol');
            const chunks: Uint8Array[] = [];
            let length = 0;
            reader = response.body.getReader();
            for (;;) {
              const next = await Promise.race([reader.read(), deadline]);
              if (next.done) break;
              const chunk = next.value;
              length += chunk.length;
              responseBytes += chunk.length;
              if (length > limits.responseBytes || responseBytes > limits.totalResponseBytes) return refuse('bounds');
              withinCall();
              chunks.push(chunk);
            }
            const bytes = Buffer.concat(chunks);
            let value: unknown;
            try {
              value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
            } catch {
              return refuse('protocol');
            }
            if (!bounded(value)) return refuse('bounds');
            const schema = await Promise.race([wireParser(file, schemaName), deadline]);
            const parsed = schema.safeParse(value);
            if (!parsed.success) return refuse('protocol');
            if (schemaName === 'ReadyResponse') {
              const ready = (parsed.data as { ready: boolean }).ready;
              if (ready !== (response.status === 200)) return refuse('protocol');
            }
            const at = withinCall();
            // Response digests are private metadata, not a claim of provider invoice/authenticity.
            evidence.push(hash(bytes));
            return { value: parsed.data as T, at };
          } catch (error) {
            if (error instanceof CollectionRefusal) throw error;
            return refuse(controller.signal.aborted ? 'deadline' : 'unreachable');
          } finally {
            clearTimeout(timer);
            controller.abort();
            if (reader) {
              // Cleanup must not keep the caller waiting after the deadline, even for an uncooperative stream.
              void reader.cancel().catch(() => undefined);
              try {
                reader.releaseLock();
              } catch {
                /* Already closed/released: no authority or retry follows. */
              }
            }
          }
        }
        if (!(await get<{ ready: boolean }>('/v1/ready', 'ready', 'ReadyResponse')).value.ready)
          return { kind: 'unavailable', code: 'not_ready' };
        async function status(path: string) {
          const observed = await get<unknown>(path, 'responses', 'RunStatus');
          const parsed = CutroomChainStatusSnapshotSchema.safeParse(observed.value);
          if (!parsed.success || parsed.data.requestId !== identity.requestId) return refuse('protocol');
          return { value: parsed.data, at: observed.at };
        }
        const first = await status(`/v1/runs?requestId=${encodeURIComponent(identity.requestId)}`);
        const opening = [first];
        const linked = first.value.resumes ?? first.value.resumedBy;
        if (linked) {
          if (linked === first.value.runId || (first.value.resumes && first.value.resumedBy)) return refuse('protocol');
          const other = await status(`/v1/runs/${encodeURIComponent(linked)}`);
          if (
            other.value.runId !== linked ||
            (first.value.resumes
              ? other.value.resumes !== undefined ||
                other.value.resumedBy !== first.value.runId ||
                first.value.resumedBy !== undefined
              : other.value.resumes !== first.value.runId || other.value.resumedBy !== undefined)
          )
            return refuse('protocol');
          opening.push(other);
        }
        if (opening.some((s) => s.value.state !== 'finished')) return { kind: 'pending', code: 'running' };
        const runs: CutroomChainInput['runs'] = [];
        for (const opened of opening) {
          const id = encodeURIComponent(opened.value.runId);
          const result = await get<Terminal>(`/v1/runs/${id}/result`, 'responses', 'RunResult');
          const record = await get<EngineRecord>(`/v1/runs/${id}/record`, 'record', 'RunRecord');
          runs.push({
            statusUtf8: serialized(opened.value, CutroomChainStatusSnapshotSchema),
            resultUtf8: terminalProjection(result.value),
            recordUtf8: recordProjection(record.value),
            closingStatusUtf8: '',
            openedAtMs: opened.at,
            resultAtMs: result.at,
            recordAtMs: record.at,
            closedAtMs: 0,
          });
        }
        // Close EVERY run only after ALL result/record reads; never refresh and silently loop.
        for (const [index, opened] of opening.entries()) {
          const closing = await status(`/v1/runs/${encodeURIComponent(opened.value.runId)}`);
          if (hash(JSON.stringify(closing.value)) !== hash(JSON.stringify(opened.value)))
            return { kind: 'pending', code: 'changing' };
          runs[index]!.closingStatusUtf8 = serialized(closing.value, CutroomChainStatusSnapshotSchema);
          runs[index]!.closedAtMs = closing.at;
        }
        const observedAtMs = time();
        const report = validatePinnedCutroomChain({
          upstreamRevision: profile.upstreamRevision,
          validationTimeMs: observedAtMs,
          expected: identity,
          runs,
        });
        return {
          kind: 'observed',
          report,
          evidenceSha256: hash(JSON.stringify(evidence)),
          calls,
          responseBytes,
          observedAtMs,
        };
      } catch (error) {
        return error instanceof CollectionRefusal ? error.result : { kind: 'unknown', code: 'protocol' };
      }
    },
  };
}
