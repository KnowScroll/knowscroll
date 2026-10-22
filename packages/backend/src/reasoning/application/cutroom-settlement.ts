import { z } from 'zod';
import type {
  CutroomSettlement,
  CutroomSettlementPermit,
  CutroomSettlementPorts,
  CutroomSettlementRecord,
  CutroomConfirmedSettlement,
} from './cutroom-settlement-ports.js';

const permits = new WeakMap<CutroomSettlementPermit, CutroomSettlementRecord>();
/** The pool adapter consumes once. A copied, closed or arbitrary operation cannot cause SQL. */
export function consumeCutroomSettlementPermit(permit: CutroomSettlementPermit): CutroomSettlementRecord | undefined {
  const record = permits.get(permit);
  permits.delete(permit);
  return record;
}
const draftSchema = z.strictObject({
  publicationId: z.uuid(),
  snapshotId: z.uuid(),
  snapshotSha256: z.string().regex(/^[0-9a-f]{64}$/),
  finalRunId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/),
  actualCents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  financialReport: z.unknown(),
});
const digest = z.string().regex(/^[0-9a-f]{64}$/),
  ref = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/),
  money = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const outcome = z.enum(['completed', 'refused', 'stopped', 'failed', 'cancelled']);
const Financial = z
  .strictObject({
    version: z.literal('cutroom-financial.v1'),
    worldId: z.enum(['dev', 'stage']),
    businessRunId: z.uuid(),
    attemptId: z.uuid(),
    requestId: ref,
    requestSha256: digest,
    dispatchId: z.uuid(),
    poolReceipt: z.strictObject({
      bindingId: z.uuid(),
      claimedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
      boundAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
    }),
    runs: z
      .array(
        z.strictObject({
          runId: ref,
          status: outcome,
          ownCostCents: money,
          resultSha256: digest,
          recordSha256: digest,
        }),
      )
      .min(1)
      .max(2),
    finalRunId: ref,
    outcome,
    actualCents: money,
  })
  .refine(
    (v) =>
      new Set(v.runs.map((r) => r.runId)).size === v.runs.length &&
      v.runs.at(-1)!.runId === v.finalRunId &&
      v.runs.at(-1)!.status === v.outcome &&
      v.runs.reduce((n, r) => n + BigInt(r.ownCostCents), 0n) === BigInt(v.actualCents),
  );
/** Stable accounting projection: excludes collection time, publication UUID and raw/provider data. */
export function parseCutroomFinancialReport(input: unknown) {
  const p = Financial.safeParse(input);
  return p.success ? p.data : undefined;
}
/** Validate the immutable receipt/report join without trusting a mutable confirmed flag alone. */
export function confirmedSettlementValid(value: CutroomConfirmedSettlement, h: (utf8: string) => string): boolean {
  const report = parseCutroomFinancialReport(value.financialReport);
  if (
    !report ||
    report.outcome !== 'completed' ||
    report.actualCents > 75 ||
    h(JSON.stringify(report)) !== value.financialReportSha256 ||
    new TextEncoder().encode(value.receiptUtf8).byteLength > 8192 ||
    h(value.receiptUtf8) !== value.receiptSha256
  )
    return false;
  try {
    const receipt = z
      .strictObject({
        version: z.literal('cutroom-settlement-receipt.v1'),
        operationId: z.uuid(),
        evidenceSha256: digest,
        evidenceId: digest,
        receipt: Financial.shape.poolReceipt,
      })
      .safeParse(JSON.parse(value.receiptUtf8));
    return (
      receipt.success &&
      receipt.data.operationId === value.operationId &&
      receipt.data.evidenceSha256 === value.financialReportSha256 &&
      receipt.data.evidenceId === value.poolEvidenceId &&
      JSON.stringify(receipt.data.receipt) === JSON.stringify(report.poolReceipt)
    );
  } catch {
    return false;
  }
}
const targetSchema = z.strictObject({
  worldId: z.enum(['dev', 'stage']),
  businessRunId: z.uuid(),
  attemptId: z.uuid(),
});
/** Publication and an immutable settlement command precede every pool mutation. Unknown
 * pool/COMMIT results reconcile the SAME command; no balance or new attempt is created. */
export function makeCutroomSettlement(p: CutroomSettlementPorts): CutroomSettlement {
  const enabled = p.enabled === true;
  return {
    async createInScope(scope, attemptId, input) {
      if (!enabled || !z.uuid().safeParse(attemptId).success) return;
      const draft = draftSchema.safeParse(input);
      const report = draft.success ? parseCutroomFinancialReport(draft.data.financialReport) : undefined;
      return draft.success && report
        ? p.store.create(scope, attemptId, { ...draft.data, financialReport: report })
        : undefined;
    },
    async recordHold(input, snapshotId, value) {
      if (!enabled || !z.uuid().safeParse(snapshotId).success) return;
      const target = targetSchema.safeParse(input),
        report = parseCutroomFinancialReport(value);
      if (!target.success || !report) return;
      const r = await p.withAccountingScope(target.data, (scope) => p.store.createHold(scope, snapshotId, report));
      return r.kind === 'entered' ? r.value : undefined;
    },
    async process(input, operationId) {
      if (!enabled) return 'disabled';
      const target = targetSchema.safeParse(input);
      if (!target.success || !z.uuid().safeParse(operationId).success) return 'held';
      const entered = await p.withAccountingScope(target.data, (scope) => p.store.read(scope, operationId));
      if (entered.kind !== 'entered' || !entered.value || entered.value.operationId !== operationId) return 'held';
      const record = entered.value;
      if (record.state === 'confirmed') return 'confirmed';
      const permit = Object.freeze({}) as CutroomSettlementPermit;
      // No private context, bytes or broad accounting authority escapes the committed read.
      permits.set(
        permit,
        Object.freeze({
          ...record,
          identity: Object.freeze({ ...record.identity }),
          receipt: Object.freeze({ ...record.receipt }),
        }),
      );
      let result;
      try {
        result = await p.pool.settle(permit);
      } finally {
        permits.delete(permit);
      }
      const saved = await p.withAccountingScope(target.data, async (scope) => {
        const current = await p.store.read(scope, operationId);
        if (!current || current.operationId !== record.operationId || current.evidenceSha256 !== record.evidenceSha256)
          return false;
        if (current.state !== 'confirmed') await p.store.finish(scope, current, result);
        return current.state === 'confirmed' || result.kind === 'confirmed';
      });
      return saved.kind === 'entered' && saved.value ? 'confirmed' : 'held';
    },
  };
}
