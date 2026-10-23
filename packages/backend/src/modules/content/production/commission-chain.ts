import type { z } from 'zod';
import {
  CUTROOM_CHAIN_LIMITS as limits,
  CUTROOM_CHAIN_UPSTREAM_REVISION,
  CutroomChainInputSchema,
  CutroomChainStatusSnapshotSchema,
  CutroomChainResultSnapshotSchema,
  CutroomChainRecordSnapshotSchema,
  type CutroomChainInput,
  type CutroomChainReport,
  type CutroomChainStatusSnapshot,
  type CutroomChainResultSnapshot,
  type CutroomChainRecordSnapshot,
  type CutroomChainLabel,
} from './commission-contracts.js';
import { reelFingerprint } from './commission-review.js';

type CompleteRun = {
  readonly status: CutroomChainStatusSnapshot;
  readonly result: CutroomChainResultSnapshot;
  readonly record: CutroomChainRecordSnapshot;
  readonly closing: CutroomChainStatusSnapshot;
  readonly observation: CutroomChainInput['runs'][number];
};
const held = (code: Extract<CutroomChainReport, { kind: 'held' }>['code']): CutroomChainReport => ({
  kind: 'held',
  code,
});
const equal = (a: unknown, b: unknown) => reelFingerprint(a) === reelFingerprint(b);

/** JSON has already passed its byte bound. Walk iteratively BEFORE Zod/hashing can recurse. */
function bounded(value: unknown): boolean {
  const stack = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const item = stack.pop()!;
    if (++nodes > limits.nodesPerDocument || item.depth > limits.depth) return false;
    if (item.value !== null && typeof item.value === 'object') {
      const children = Array.isArray(item.value) ? item.value : Object.values(item.value);
      if (children.length + nodes + stack.length > limits.nodesPerDocument) return false;
      for (const child of children) stack.push({ value: child, depth: item.depth + 1 });
    }
  }
  return true;
}
function document<T>(utf8: string, schema: z.ZodType<T>): T | undefined {
  try {
    const value: unknown = JSON.parse(utf8);
    if (!bounded(value)) return undefined;
    const result = schema.safeParse(value);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}
function completeRun(observation: CutroomChainInput['runs'][number], requestId: string): CompleteRun | undefined {
  const status = document(observation.statusUtf8, CutroomChainStatusSnapshotSchema);
  const closing = document(observation.closingStatusUtf8, CutroomChainStatusSnapshotSchema);
  const result = document(observation.resultUtf8, CutroomChainResultSnapshotSchema);
  const record = document(observation.recordUtf8, CutroomChainRecordSnapshotSchema);
  if (!status || !closing || !result || !record) return undefined;
  if (
    status.state !== 'finished' ||
    closing.state !== 'finished' ||
    status.requestId !== requestId ||
    result.requestId !== requestId ||
    status.runId !== result.runId ||
    record.runId !== status.runId ||
    !equal(status, closing)
  )
    return undefined;
  return { status, closing, result, record, observation };
}
function validRecord(record: CutroomChainRecordSnapshot): boolean {
  if (new Set(record.pictures.map((p) => p.pictureId)).size !== record.pictures.length) return false;
  if (new Set(record.takes.map((p) => p.takeId)).size !== record.takes.length) return false;
  return [...record.pictures, ...record.takes].every(
    (p) => new Set(p.checks.map((c) => `${c.gate}:${'step' in c ? c.step : ''}`)).size === p.checks.length,
  );
}
/** Chosen/used selection flags legitimately change; every copied immutable field must match. */
function ancestry(original: CompleteRun, child?: CompleteRun): boolean {
  if ([...original.record.pictures, ...original.record.takes].some((p) => p.keptFrom !== undefined)) return false;
  if (!child) return true;
  for (const picture of child.record.pictures) {
    const parent = original.record.pictures.find((p) => p.pictureId === picture.pictureId);
    if (picture.keptFrom === undefined) {
      if (parent) return false;
      continue;
    }
    if (picture.keptFrom !== original.status.runId || !parent) return false;
    const { chosen: _chosen, keptFrom: _kept, ...data } = picture;
    const { chosen: _parentChosen, keptFrom: _parentKept, ...source } = parent;
    if (!equal(data, source)) return false;
  }
  for (const take of child.record.takes) {
    const parent = original.record.takes.find((p) => p.takeId === take.takeId);
    if (take.keptFrom === undefined) {
      if (parent) return false;
      continue;
    }
    if (take.keptFrom !== original.status.runId || !parent) return false;
    const { used: _used, keptFrom: _kept, ...data } = take;
    const { used: _parentUsed, keptFrom: _parentKept, ...source } = parent;
    if (!equal(data, source)) return false;
  }
  return true;
}
function video(tip: CompleteRun): Extract<CutroomChainReport, { kind: 'complete' }>['video'] {
  const result = tip.result;
  if (result.status !== 'completed' || result.until !== 'video') return { kind: 'unavailable', code: 'not_video' };
  const chosen = tip.record.pictures.filter((p) => p.chosen),
    used = tip.record.takes.filter((p) => p.used);
  if (
    !chosen.length ||
    !used.length ||
    new Set(chosen.map((p) => p.shotId)).size !== chosen.length ||
    new Set(used.map((p) => p.shotId)).size !== used.length ||
    new Set(result.stills.map((p) => p.pictureId)).size !== result.stills.length ||
    new Set(result.stills.map((p) => p.shotId)).size !== result.stills.length ||
    result.stills.length !== chosen.length ||
    !equal(result.degradations, tip.record.degradations) ||
    result.stills.some(
      (s) =>
        !chosen.some((p) => p.pictureId === s.pictureId && p.shotId === s.shotId) ||
        !(used.some((t) => t.shotId === s.shotId) || tip.record.degradations.some((d) => d.shotId === s.shotId)),
    )
  )
    return { kind: 'unavailable', code: 'record' };
  for (const p of chosen) {
    if (
      p.checks.some((c) => c.outcome === 'fail') ||
      ['technical', 'text', 'witness', 'reconcile'].some(
        (step) => !p.checks.some((c) => c.gate === '1' && c.step === step),
      )
    )
      return { kind: 'unavailable', code: 'gates' };
  }
  for (const t of used) {
    if (
      t.checks.some((c) => c.outcome === 'fail') ||
      ['2', '3', '4', '5'].some((gate) => !t.checks.some((c) => c.gate === gate))
    )
      return { kind: 'unavailable', code: 'gates' };
  }
  const labels: CutroomChainLabel[] = [];
  for (const p of chosen)
    for (const c of p.checks)
      if (c.outcome === 'accept_with_label')
        labels.push({
          pieceSha256: reelFingerprint({ kind: 'picture', id: p.pictureId }),
          gate: c.gate,
          ...(c.step ? { step: c.step } : {}),
          outcome: c.outcome,
        });
  for (const t of used)
    for (const c of t.checks)
      if (c.outcome === 'accept_with_label')
        labels.push({ pieceSha256: reelFingerprint({ kind: 'take', id: t.takeId }), gate: c.gate, outcome: c.outcome });
  labels.sort((a, b) => {
    const x = `${a.pieceSha256}:${a.gate}:${a.step ?? ''}`,
      y = `${b.pieceSha256}:${b.gate}:${b.step ?? ''}`;
    return x < y ? -1 : x > y ? 1 : 0;
  });
  return { kind: 'candidate', runSha256: reelFingerprint(tip.status.runId), labels };
}
/** Pure data check ONLY. Supplied revision/timestamps/digests do not attest a running engine or permit settlement. */
export function validatePinnedCutroomChain(input: unknown): CutroomChainReport {
  try {
    // Bound the shallow envelope/array BEFORE Zod iterates any caller-supplied run collection.
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return held('shape');
    const runs = (input as { runs?: unknown }).runs;
    if (!Array.isArray(runs) || runs.length < 1 || runs.length > limits.runs) return held('bounds');
    let bytes = 0;
    for (const run of runs) {
      if (run === null || typeof run !== 'object' || Array.isArray(run)) return held('shape');
      for (const key of ['statusUtf8', 'resultUtf8', 'recordUtf8', 'closingStatusUtf8'] as const) {
        const value = (run as Record<string, unknown>)[key];
        if (typeof value !== 'string') return held('shape');
        if (value.length > limits.documentBytes) return held('bounds');
        const size = Buffer.byteLength(value, 'utf8');
        bytes += size;
        if (size > limits.documentBytes || bytes > limits.totalBytes) return held('bounds');
      }
    }
    const parsed = CutroomChainInputSchema.safeParse(input);
    if (!parsed.success) return held('shape');
    const v = parsed.data;
    if (v.upstreamRevision !== CUTROOM_CHAIN_UPSTREAM_REVISION) return held('profile');
    if (v.expected.requestId !== `ks-reel-${v.expected.scriptSha256.slice(0, 32)}-${v.expected.take}`)
      return held('identity');
    for (const o of v.runs)
      if (
        o.openedAtMs > Math.min(o.resultAtMs, o.recordAtMs) ||
        o.closedAtMs < Math.max(o.resultAtMs, o.recordAtMs) ||
        o.closedAtMs > v.validationTimeMs ||
        v.validationTimeMs - o.openedAtMs > limits.freshnessMs
      )
        return held('incomplete');
    const complete = v.runs.map((o) => completeRun(o, v.expected.requestId));
    if (complete.some((r) => !r)) return held('incomplete');
    const observed = complete.filter((r): r is CompleteRun => r !== undefined);
    if (new Set(observed.map((r) => r.status.runId)).size !== observed.length) return held('chain');
    const roots = observed.filter((r) => r.status.resumes === undefined);
    if (roots.length !== 1) return held('chain');
    const root = roots[0]!;
    const child = observed.find((r) => r !== root);
    if (
      child
        ? root.status.resumedBy !== child.status.runId ||
          child.status.resumes !== root.status.runId ||
          child.status.resumedBy !== undefined
        : root.status.resumedBy !== undefined
    )
      return held('chain');
    // This profile is engine-only auto-resume; caller-created Gate7 resumes are outside it.
    if (child && root.result.status !== 'failed') return held('profile');
    const ordered = child ? [root, child] : [root];
    if (ordered.some((r) => !validRecord(r.record)) || !ancestry(root, child)) return held('record');
    let cost = 0n;
    for (const r of ordered) cost += BigInt(r.result.costCents);
    if (cost > BigInt(Number.MAX_SAFE_INTEGER)) return held('cost');
    const actualCents = Number(cost);
    return {
      kind: 'complete',
      requiredUpstreamRevision: CUTROOM_CHAIN_UPSTREAM_REVISION,
      chainSha256: reelFingerprint({
        expected: v.expected,
        upstreamRevision: v.upstreamRevision,
        runs: ordered.map((r) => ({
          status: r.status,
          closing: r.closing,
          result: r.result,
          record: r.record,
          openedAtMs: r.observation.openedAtMs,
          resultAtMs: r.observation.resultAtMs,
          recordAtMs: r.observation.recordAtMs,
          closedAtMs: r.observation.closedAtMs,
        })),
      }),
      attemptSha256: reelFingerprint(v.expected),
      runs: ordered.map((r) => ({
        runSha256: reelFingerprint(r.status.runId),
        status: r.result.status,
        ownCostCents: r.result.costCents,
        resultSha256: reelFingerprint(r.result),
        recordSha256: reelFingerprint(r.record),
      })),
      cost: { kind: 'complete_engine_reported', actualCents, overCeiling: actualCents > v.expected.ceilingCents },
      video: video(ordered[ordered.length - 1]!),
      attestation: 'engine-attested-not-independent; cost-not-provider-invoice',
    };
  } catch {
    return held('shape');
  }
}
