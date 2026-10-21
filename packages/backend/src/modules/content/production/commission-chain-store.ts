import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CutroomAccountingScopeTx, CutroomExecutionBinding } from '../../../reasoning/public.js';
import {
  CutroomCollectedChainSchema,
  CutroomChainInputSchema,
  CutroomChainStatusSnapshotSchema,
  CUTROOM_CHAIN_LIMITS,
  type CutroomCollectedChain,
  type CutroomChainReport,
} from './commission-contracts.js';
import { validatePinnedCutroomChain } from './commission-chain.js';
import type {
  ChainDocument,
  ChainDocumentKind,
  ChainSnapshotHeader,
  SealedChainSnapshot,
  StoredChainSnapshot,
  CommissionChainStorePorts,
  CommissionChainSnapshots,
  ChainStoreRefusal,
} from './commission-chain-store-ports.js';
const hash = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const ref = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/);
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const micros = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
const kinds: readonly ChainDocumentKind[] = ['opening', 'result', 'record', 'closing'];
const fields = ['statusUtf8', 'resultUtf8', 'recordUtf8', 'closingStatusUtf8'] as const;
const headerSchema = z.strictObject({
  version: z.literal('cutroom-chain-snapshot.v1'),
  expected: CutroomChainInputSchema.shape.expected,
  execution: z.strictObject({
    dispatchId: z.uuid(),
    fence: z.number().int().positive().max(2147483647),
    requestSha256: digest,
    reviewSha256: digest,
    corpusSha256: digest,
    humanEvidenceRef: ref,
    profileSha256: digest,
    soleWriterEvidenceSha256: digest,
    fundsEvidenceSha256: digest,
    poolReceipt: z.strictObject({ bindingId: z.uuid(), claimedAt: micros, boundAt: micros }),
  }),
  collection: CutroomCollectedChainSchema.omit({ version: true, input: true }),
  runs: z
    .array(
      z.strictObject({
        runId: ref,
        openedAtMs: counter,
        resultAtMs: counter,
        recordAtMs: counter,
        closedAtMs: counter,
      }),
    )
    .min(1)
    .max(2),
  documents: z
    .array(
      z.strictObject({
        runOrdinal: z.number().int().min(0).max(1),
        kind: z.enum(['opening', 'result', 'record', 'closing']),
        byteLength: z.number().int().min(1).max(262144),
        sha256: digest,
      }),
    )
    .min(4)
    .max(8),
  summary: z.strictObject({
    chainSha256: digest,
    attemptSha256: digest,
    actualCents: counter,
    overCeiling: z.boolean(),
    videoKind: z.enum(['candidate', 'unavailable']),
    videoCode: z.enum(['not_video', 'record', 'gates']).nullable(),
  }),
});
const selectorSchema = z.union([
  z.strictObject({ snapshotId: z.uuid(), snapshotSha256: digest }),
  z.strictObject({ observationId: z.uuid() }),
]);
const refused = (code: ChainStoreRefusal) => ({ kind: 'refused', code }) as const;
type Complete = Extract<CutroomChainReport, { kind: 'complete' }>;
interface Draft {
  readonly collected: CutroomCollectedChain;
  readonly report: Complete;
  readonly documents: readonly ChainDocument[];
  readonly runs: ChainSnapshotHeader['runs'];
}
/** Full pure validation occurs before the world transaction. No caller report/cost/clear is trusted. */
function prepare(input: unknown): Draft | undefined {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length > 8) return;
    const raw = input as Record<string, unknown>;
    if (
      Object.entries(raw).some(
        ([key, value]) =>
          key !== 'input' &&
          key !== 'profile' &&
          ((typeof value === 'string' && value.length > 128) || typeof value === 'object'),
      )
    )
      return;
    const profile = raw.profile;
    if (
      !profile ||
      typeof profile !== 'object' ||
      Array.isArray(profile) ||
      Object.keys(profile).length > 4 ||
      Object.values(profile).some(
        (value) => typeof value === 'object' || (typeof value === 'string' && value.length > 128),
      )
    )
      return;
    const candidate = raw.input;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) || Object.keys(candidate).length > 4)
      return;
    const expected = (candidate as { expected?: unknown }).expected;
    if (
      !expected ||
      typeof expected !== 'object' ||
      Array.isArray(expected) ||
      Object.keys(expected).length > 10 ||
      Object.values(expected).some(
        (value) => typeof value === 'object' || (typeof value === 'string' && value.length > 128),
      )
    )
      return;
    const report = validatePinnedCutroomChain(candidate);
    if (report.kind !== 'complete') return;
    const parsed = CutroomCollectedChainSchema.safeParse(input);
    if (!parsed.success) return;
    const c = parsed.data,
      at = c.observedAtMs;
    if (
      at !== c.input.validationTimeMs ||
      c.calls !== (c.input.runs.length === 1 ? 5 : 9) ||
      c.profile.observedAtMs > at ||
      c.profile.expiresAtMs <= at ||
      c.profile.expiresAtMs - c.profile.observedAtMs > CUTROOM_CHAIN_LIMITS.freshnessMs
    )
      return;
    // Normalize only the already validated original/child ordering; preserve every document byte.
    const status = (text: string) => CutroomChainStatusSnapshotSchema.parse(JSON.parse(text));
    c.input.runs.sort(
      (a, b) => Number(status(a.statusUtf8).resumes !== undefined) - Number(status(b.statusUtf8).resumes !== undefined),
    );
    const documents: ChainDocument[] = [];
    const runs = c.input.runs.map((r, runOrdinal) => {
      for (const [index, field] of fields.entries()) {
        const bodyUtf8 = r[field];
        documents.push({
          runOrdinal,
          kind: kinds[index]!,
          bodyUtf8,
          byteLength: Buffer.byteLength(bodyUtf8, 'utf8'),
          sha256: hash(bodyUtf8),
        });
      }
      return {
        runId: status(r.statusUtf8).runId,
        openedAtMs: r.openedAtMs,
        resultAtMs: r.resultAtMs,
        recordAtMs: r.recordAtMs,
        closedAtMs: r.closedAtMs,
      };
    });
    return { collected: c, report, documents, runs };
  } catch {
    return;
  }
}
function seal(d: Draft, execution: CutroomExecutionBinding): SealedChainSnapshot | undefined {
  const c = d.collected,
    report = d.report;
  if (
    c.profile.soleWriterEvidenceSha256 !== execution.soleWriterEvidenceSha256 ||
    execution.requestSha256 !== c.input.expected.requestSha256
  )
    return;
  const header: ChainSnapshotHeader = {
    version: 'cutroom-chain-snapshot.v1',
    expected: c.input.expected,
    execution,
    collection: {
      evidenceSha256: c.evidenceSha256,
      calls: c.calls,
      responseBytes: c.responseBytes,
      observedAtMs: c.observedAtMs,
      profile: c.profile,
    },
    runs: d.runs,
    documents: d.documents.map(({ bodyUtf8: _body, ...vector }) => vector),
    summary: {
      chainSha256: report.chainSha256,
      attemptSha256: report.attemptSha256,
      actualCents: report.cost.actualCents,
      overCeiling: report.cost.overCeiling,
      videoKind: report.video.kind,
      videoCode: report.video.kind === 'unavailable' ? report.video.code : null,
    },
  };
  const parsed = headerSchema.safeParse(header);
  if (!parsed.success) return;
  const headerUtf8 = JSON.stringify(parsed.data);
  if (Buffer.byteLength(headerUtf8, 'utf8') > 8192) return;
  return { header: parsed.data, headerUtf8, snapshotSha256: hash(headerUtf8), documents: d.documents };
}
function expectedMatches(scope: CutroomAccountingScopeTx, d: Draft): boolean {
  const e = d.collected.input.expected,
    i = scope.identity;
  return (
    e.attemptId === scope.attemptId &&
    e.businessRunId === scope.businessRunId &&
    e.worldId === scope.worldId &&
    e.contractVersion === 1 &&
    e.requestId === i.requestId &&
    e.requestSha256 === i.requestSha256 &&
    e.scriptSha256 === i.scriptSha256 &&
    e.take === i.take &&
    e.ceilingCents === i.ceilingCents
  );
}
function hydrate(
  s: StoredChainSnapshot,
  binding: CutroomExecutionBinding,
): { sealed: SealedChainSnapshot; report: Complete } | undefined {
  try {
    if (
      s.headerUtf8.length > 8192 ||
      Buffer.byteLength(s.headerUtf8, 'utf8') > 8192 ||
      s.documents.length < 4 ||
      s.documents.length > 8
    )
      return;
    const parsed = headerSchema.safeParse(JSON.parse(s.headerUtf8));
    if (!parsed.success) return;
    const header = parsed.data;
    let documentBytes = 0;
    const runs = header.runs.map((r, runOrdinal) => {
      const value = {
        openedAtMs: r.openedAtMs,
        resultAtMs: r.resultAtMs,
        recordAtMs: r.recordAtMs,
        closedAtMs: r.closedAtMs,
        statusUtf8: '',
        resultUtf8: '',
        recordUtf8: '',
        closingStatusUtf8: '',
      };
      for (const [index, field] of fields.entries()) {
        const docs = s.documents.filter((d) => d.runOrdinal === runOrdinal && d.kind === kinds[index]);
        if (docs.length !== 1) throw new Error('CHAIN_DOCUMENT_SET');
        const d = docs[0]!;
        if (d.bodyUtf8.length > 262144) throw new Error('CHAIN_DOCUMENT_BOUNDS');
        const bytes = Buffer.byteLength(d.bodyUtf8, 'utf8');
        documentBytes += bytes;
        if (bytes > 262144 || documentBytes > 2097152 || bytes !== d.byteLength || hash(d.bodyUtf8) !== d.sha256)
          throw new Error('CHAIN_DOCUMENT_HASH');
        value[field] = d.bodyUtf8;
      }
      return value;
    });
    const draft = prepare({
      version: 'cutroom-chain-collection.v1',
      ...header.collection,
      input: {
        upstreamRevision: header.collection.profile.upstreamRevision,
        validationTimeMs: header.collection.observedAtMs,
        expected: header.expected,
        runs,
      },
    });
    const sealed = draft && seal(draft, binding);
    if (
      !sealed ||
      sealed.headerUtf8 !== s.headerUtf8 ||
      sealed.snapshotSha256 !== s.snapshotSha256 ||
      s.documentCount !== sealed.documents.length ||
      s.totalDocumentBytes !== sealed.documents.reduce((n, d) => n + d.byteLength, 0) ||
      s.validationTimeMs !== String(header.collection.observedAtMs) ||
      s.actualCents !== String(header.summary.actualCents) ||
      s.overCeiling !== header.summary.overCeiling ||
      s.videoKind !== header.summary.videoKind
    )
      return;
    return { sealed, report: draft.report };
  } catch {
    return;
  }
}
/** Explicit disabled composition; records evidence only. Never a dispatch, money or media method. */
export function makeCommissionChainSnapshots(p: CommissionChainStorePorts): CommissionChainSnapshots {
  const enabled = p.enabled === true;
  return {
    async recordCollectedChain(target, collected) {
      if (!enabled) return refused('disabled');
      const draft = prepare(collected);
      if (!draft) return refused('invalid');
      try {
        const result = await p.withAccountingScope(target, async (scope) => {
          if (!expectedMatches(scope, draft)) return refused('identity');
          const binding = await p.execution.readAccountingBinding(scope);
          const snapshot = binding && seal(draft, binding);
          if (!snapshot) return refused('identity');
          const slot = await p.store.inspect(scope, snapshot);
          if (slot.kind === 'refused') return slot;
          if (slot.kind === 'replayed') {
            const matched = await p.execution.matchesAccountingObservation(
              scope,
              slot.observationId,
              snapshot.snapshotSha256,
              snapshot.header.runs[0]!.runId,
            );
            return matched ? { ...slot, snapshotSha256: snapshot.snapshotSha256 } : refused('corrupt');
          }
          // New complete-path key is the sealed snapshot hash, NOT the raw-body aggregate.
          const observation = await p.execution.recordObservationInScope(scope, {
            requestId: snapshot.header.expected.requestId,
            runId: snapshot.header.runs[0]!.runId,
            evidenceSha256: snapshot.snapshotSha256,
            outcome: 'terminal_unvalidated',
          });
          if (observation.kind !== 'pending') throw new Error('CHAIN_OBSERVATION_REFUSED');
          const snapshotId = await p.store.insert(scope, snapshot, slot.ordinal, observation.observationId);
          return {
            kind: 'recorded',
            snapshotId,
            observationId: observation.observationId,
            snapshotSha256: snapshot.snapshotSha256,
          } as const;
        });
        return result.kind === 'entered' ? result.value : result;
      } catch {
        return refused('unavailable');
      } // Outside withScope: every post-write error rolled back.
    },
    async readSnapshot(target, selector) {
      if (!enabled) return refused('disabled');
      const parsed = selectorSchema.safeParse(selector);
      if (!parsed.success) return refused('invalid');
      try {
        const result = await p.withAccountingScope(target, async (scope) => {
          const binding = await p.execution.readAccountingBinding(scope);
          if (!binding) return;
          const stored = await p.store.read(scope, parsed.data);
          if (!stored || stored.headerUtf8.length > 8192 || Buffer.byteLength(stored.headerUtf8, 'utf8') > 8192) return;
          const header = headerSchema.safeParse(JSON.parse(stored.headerUtf8));
          if (
            !header.success ||
            !(await p.execution.matchesAccountingObservation(
              scope,
              stored.observationId,
              stored.snapshotSha256,
              header.data.runs[0]!.runId,
            ))
          )
            return;
          return {
            stored,
            binding,
            identity: scope.identity,
            worldId: scope.worldId,
            attemptId: scope.attemptId,
            businessRunId: scope.businessRunId,
          };
        });
        if (result.kind !== 'entered' || !result.value) return refused('identity');
        const { stored, binding } = result.value,
          value = hydrate(stored, binding);
        const e = value?.sealed.header.expected,
          i = result.value.identity;
        if (
          !value ||
          !e ||
          e.worldId !== result.value.worldId ||
          e.attemptId !== result.value.attemptId ||
          e.businessRunId !== result.value.businessRunId ||
          e.requestId !== i.requestId ||
          e.requestSha256 !== i.requestSha256 ||
          e.scriptSha256 !== i.scriptSha256 ||
          e.take !== i.take ||
          e.ceilingCents !== i.ceilingCents
        )
          return refused('corrupt');
        return {
          kind: 'snapshot',
          snapshotId: stored.snapshotId,
          observationId: stored.observationId,
          snapshotSha256: stored.snapshotSha256,
          header: value.sealed.header,
          documents: value.sealed.documents,
          report: value.report,
        };
      } catch {
        return refused('unavailable');
      }
    },
  };
}
