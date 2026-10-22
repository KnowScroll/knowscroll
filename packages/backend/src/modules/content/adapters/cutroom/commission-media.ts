import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { localMediaStore } from '../../../../infrastructure/media-store/index.js';
import { assertOutsideTransaction } from '../../../../infrastructure/postgres/transaction-marker.js';
import { reelFingerprint } from '../../production/commission-review.js';
import type {
  CommissionMedia,
  CommissionMediaProof,
  CommissionVerifiedMedia,
} from '../../production/commission-publication-ports.js';
import { cutroomReadClient, type EngineRecord, type VideoResult, type RunStatus } from './read-client.js';
import { probeReel } from './probe.js';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const degradation = (d: { shotId: string; reason: string }) => ({ shotId: d.shotId, reasonSha256: hash(d.reason) });
function resultProjection(r: VideoResult) {
  return {
    contractVersion: r.contractVersion,
    runId: r.runId,
    requestId: r.requestId,
    costCents: r.costCents,
    status: r.status,
    until: r.until,
    stills: r.stills.map((s) => ({ pictureId: s.pictureId, shotId: s.shotId })),
    degradations: r.degradations.map(degradation),
  };
}
function recordProjection(r: EngineRecord) {
  return {
    contractVersion: r.contractVersion,
    runId: r.runId,
    pictures: r.pictures.map((p) => ({
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
    takes: r.takes.map((p) => ({
      takeId: p.takeId,
      shotId: p.shotId,
      number: p.number,
      used: p.used,
      ...(p.keptFrom === undefined ? {} : { keptFrom: p.keptFrom }),
      ...(p.observationId === undefined ? {} : { observationId: p.observationId }),
      ...(p.reconciliationId === undefined ? {} : { reconciliationId: p.reconciliationId }),
      checks: p.checks.map((c) => ({ gate: c.gate, outcome: c.outcome })),
    })),
    degradations: r.degradations.map(degradation),
  };
}
function bounded(value: unknown) {
  const stack = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const x = stack.pop()!;
    if (++nodes > 12000 || x.depth > 12) return false;
    if (x.value !== null && typeof x.value === 'object') {
      const children = Array.isArray(x.value) ? x.value : Object.values(x.value);
      if (nodes + children.length + stack.length > 12000) return false;
      for (const value of children) stack.push({ value, depth: x.depth + 1 });
    }
  }
  return true;
}
async function schema(file: 'responses' | 'record', name: string): Promise<z.ZodType> {
  const path = import.meta.url.endsWith('.ts') ? `./wire-v1/${file}.ts` : `./wire-runtime/${file}.js`;
  const loaded = (await import(new URL(path, import.meta.url).href)) as Record<string, z.ZodType>;
  if (!loaded[name]) throw new Error('CUTROOM_MEDIA_PROTOCOL');
  return loaded[name];
}

/** Fresh fixed GETs bind the actual opened file to all retained tip projections. Only a private
 * proof of staged/probed/fsynced bytes escapes; raw artifact paths/errors never do. */
export function makeCommissionMedia(settings: {
  readonly enabled?: boolean;
  readonly origin: string;
  readonly artifactRoot: string;
  readonly mediaRoot: string;
  readonly ffprobePath?: string;
}): CommissionMedia {
  const config = Object.freeze({ ...settings });
  const files = cutroomReadClient({ origin: config.origin, artifactRoot: config.artifactRoot });
  const proofs = new WeakMap<
    CommissionMediaProof,
    { snapshot: string; expires: number; media: CommissionVerifiedMedia }
  >();
  return {
    async prepare(snapshot) {
      if (config.enabled !== true) return;
      assertOutsideTransaction('cutroom.commission-media');
      const expires = snapshot.header.collection.profile.expiresAtMs;
      const now = Date.now();
      if (
        expires <= now ||
        snapshot.header.collection.profile.observedAtMs > now ||
        expires - now > 30000 ||
        snapshot.report.video.kind !== 'candidate' ||
        snapshot.report.cost.overCeiling
      )
        return;
      const controller = new AbortController();
      let rejectDeadline!: (e: Error) => void;
      const deadline = new Promise<never>((_, reject) => {
        rejectDeadline = reject;
      });
      const timer = setTimeout(
        () => {
          controller.abort();
          rejectDeadline(new Error('CUTROOM_MEDIA_DEADLINE'));
        },
        Math.min(20000, expires - now),
      );
      const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
      try {
        if (snapshot.report.video.kind !== 'candidate') return;
        const tipSha = snapshot.report.video.runSha256;
        const run = snapshot.header.runs.find((r) => reelFingerprint(r.runId) === tipSha);
        if (!run) throw new Error('CUTROOM_MEDIA_RUN_IDENTITY');
        const runId = run.runId;
        let received = 0,
          calls = 0;
        async function get(suffix: string, name: string, file: 'responses' | 'record' = 'responses') {
          if (++calls > 4 || Date.now() >= expires) throw new Error('CUTROOM_MEDIA_DEADLINE');
          const origin = new URL(config.origin);
          // files' constructor already validates exact HTTP loopback origin; route is fixed.
          const response = await Promise.race([
            // eslint-disable-next-line no-restricted-globals -- Fixed GET-only current terminal media verification, outside transactions.
            fetch(new URL(`/v1/runs/${encodeURIComponent(runId)}${suffix}`, origin), {
              method: 'GET',
              redirect: 'error',
              signal: controller.signal,
            }),
            deadline,
          ]);
          if (
            response.status !== 200 ||
            !response.body ||
            !response.headers.get('content-type')?.includes('application/json')
          )
            throw new Error('CUTROOM_MEDIA_PROTOCOL');
          const reader = response.body.getReader();
          readers.push(reader);
          const chunks: Uint8Array[] = [];
          let bytes = 0;
          for (;;) {
            const item = await Promise.race([reader.read(), deadline]);
            if (item.done) break;
            bytes += item.value.byteLength;
            received += item.value.byteLength;
            if (bytes > 262144 || received > 1048576) throw new Error('CUTROOM_MEDIA_BOUNDS');
            chunks.push(item.value);
          }
          const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
          if (!bounded(raw)) throw new Error('CUTROOM_MEDIA_BOUNDS');
          return (await schema(file, name)).parse(raw);
        }
        const opening = (await get('', 'RunStatus')) as RunStatus;
        const result = (await get('/result', 'RunResult')) as VideoResult;
        const record = (await get('/record', 'RunRecord', 'record')) as EngineRecord;
        const closing = (await get('', 'RunStatus')) as RunStatus;
        if (
          result.status !== 'completed' ||
          result.until !== 'video' ||
          result.runId !== run.runId ||
          result.requestId !== snapshot.header.expected.requestId
        )
          return;
        const ordinal = snapshot.header.runs.indexOf(run);
        const retained = (kind: string) => {
          const document = snapshot.documents.find((d) => d.runOrdinal === ordinal && d.kind === kind);
          if (!document) throw new Error('CUTROOM_MEDIA_SNAPSHOT');
          return JSON.parse(document.bodyUtf8) as unknown;
        };
        if (
          reelFingerprint(opening) !== reelFingerprint(retained('opening')) ||
          reelFingerprint(closing) !== reelFingerprint(retained('closing')) ||
          reelFingerprint(resultProjection(result)) !== reelFingerprint(retained('result')) ||
          reelFingerprint(recordProjection(record)) !== reelFingerprint(retained('record'))
        )
          return;
        const file = await files.openArtifact(result.video.path, run.runId);
        const staged = await localMediaStore(config.mediaRoot).stage(file.stream);
        try {
          if (file.size !== staged.size || Date.now() >= expires) return;
          const probe = await probeReel(staged.path, config.ffprobePath);
          const media = await staged.commit();
          if (Date.now() >= expires) return;
          const proof = Object.freeze({}) as CommissionMediaProof;
          proofs.set(proof, { snapshot: snapshot.snapshotSha256, expires, media: { ...media, probe } });
          return proof;
        } finally {
          await staged.discard();
        }
      } catch {
        return;
      } finally {
        clearTimeout(timer);
        controller.abort();
        for (const reader of readers) void reader.cancel().catch(() => undefined);
      }
    },
    consume(proof, snapshot) {
      const value = proofs.get(proof);
      proofs.delete(proof);
      return value && value.snapshot === snapshot.snapshotSha256 && Date.now() < value.expires
        ? value.media
        : undefined;
    },
  };
}
