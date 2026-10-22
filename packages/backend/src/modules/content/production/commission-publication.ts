import { z } from 'zod';
import type {
  CommissionPublication,
  CommissionPublicationPorts,
  CommissionPublicationResult,
  PublicationSnapshot,
} from './commission-publication-ports.js';
import type { CommissionReviewPacket } from './commission-review-ports.js';
import { parseCutroomFinancialReport } from '../../../reasoning/public.js';
import { reelFingerprint } from './commission-review.js';
export function financialReportOfSnapshot(s: PublicationSnapshot) {
  const e = s.header.expected;
  const runs = s.report.runs.map((r) => {
    const actual = s.header.runs.find((x) => reelFingerprint(x.runId) === r.runSha256);
    if (!actual) throw new Error('CUTROOM_FINANCIAL_RUN_IDENTITY');
    const ordinal = s.header.runs.indexOf(actual);
    const result = s.documents.find((d) => d.runOrdinal === ordinal && d.kind === 'result'),
      record = s.documents.find((d) => d.runOrdinal === ordinal && d.kind === 'record');
    if (!result || !record) throw new Error('CUTROOM_FINANCIAL_DOCUMENT_IDENTITY');
    return {
      runId: actual.runId,
      status: r.status,
      ownCostCents: r.ownCostCents,
      resultSha256: result.sha256,
      recordSha256: record.sha256,
    };
  });
  const report = parseCutroomFinancialReport({
    version: 'cutroom-financial.v1',
    worldId: e.worldId,
    businessRunId: e.businessRunId,
    attemptId: e.attemptId,
    requestId: e.requestId,
    requestSha256: e.requestSha256,
    dispatchId: s.header.execution.dispatchId,
    poolReceipt: s.header.execution.poolReceipt,
    runs,
    finalRunId: runs.at(-1)!.runId,
    outcome: runs.at(-1)!.status,
    actualCents: s.report.cost.actualCents,
  });
  if (!report) throw new Error('CUTROOM_FINANCIAL_REPORT');
  return report;
}
const selection = z.strictObject({ snapshotId: z.uuid(), snapshotSha256: z.string().regex(/^[0-9a-f]{64}$/) });
const targetSchema = z.strictObject({
  worldId: z.enum(['dev', 'stage']),
  businessRunId: z.uuid(),
  attemptId: z.uuid(),
});
const held = (code: Extract<CommissionPublicationResult, { kind: 'held' }>['code']) =>
  ({ kind: 'held', code }) as const;
function matches(packet: CommissionReviewPacket, s: PublicationSnapshot) {
  const e = s.header.expected,
    b = s.header.execution;
  return (
    packet.worldId === e.worldId &&
    packet.businessRunId === e.businessRunId &&
    packet.scriptSha256 === e.scriptSha256 &&
    packet.requestId === e.requestId &&
    packet.requestSha256 === e.requestSha256 &&
    packet.take === e.take &&
    packet.ceilingCents === e.ceilingCents &&
    packet.reviewSha256 === b.reviewSha256 &&
    packet.corpusSnapshotSha256 === b.corpusSha256
  );
}
/** Shared-public admission only. Historical chain evidence alone can never open Content or
 * close a financial claim. FS/network/probe happen before the final short current-root check. */
export function makeCommissionPublication(p: CommissionPublicationPorts): CommissionPublication {
  const enabled = p.enabled === true;
  return {
    async publish(authority, input, selector) {
      if (!enabled) return held('disabled');
      const target = targetSchema.safeParse(input),
        pick = selection.safeParse(selector);
      if (!target.success || !pick.success || target.data.worldId !== authority.worldId) return held('identity');
      const t = target.data;
      const snapshot = await p.snapshots.readSnapshot(t, pick.data);
      if (snapshot.kind !== 'snapshot') return held('evidence');
      if (snapshot.report.cost.overCeiling) return held('overage');
      if (snapshot.report.video.kind !== 'candidate') return held('video');
      const before = await p.withScope(authority, 'admit', async (scope) => {
        const context = await p.store.load(scope, t);
        if (!context || !matches(context.packet, snapshot) || !(await p.review(scope, t.businessRunId))) return;
        if (context.publication) {
          if (context.publication.snapshotSha256 !== snapshot.snapshotSha256) return;
          const operationId = await p.settlement.createInScope(scope, t.attemptId, {
            publicationId: context.publication.publicationId,
            snapshotId: snapshot.snapshotId,
            snapshotSha256: snapshot.snapshotSha256,
            finalRunId: financialReportOfSnapshot(snapshot).finalRunId,
            actualCents: snapshot.report.cost.actualCents,
            financialReport: financialReportOfSnapshot(snapshot),
          });
          if (!operationId) return;
          return { ...context, operationId };
        }
        return { ...context, operationId: undefined };
      });
      if (before.kind !== 'entered' || !before.value) return held('review');
      if (before.value.publication) {
        const old = before.value.publication;
        return before.value.operationId
          ? { kind: 'published', ...old, operationId: before.value.operationId }
          : held('identity');
      }
      const proof = await p.media.prepare(snapshot);
      if (!proof) return held('media');
      try {
        const committed = await p.withScope(authority, 'admit', async (scope) => {
          const context = await p.store.load(scope, t);
          if (!context || !matches(context.packet, snapshot) || !(await p.review(scope, t.businessRunId)))
            return held('review');
          if (context.publication) {
            const old = context.publication;
            if (old.snapshotSha256 !== snapshot.snapshotSha256) return held('identity');
            const operationId = await p.settlement.createInScope(scope, t.attemptId, {
              publicationId: old.publicationId,
              snapshotId: snapshot.snapshotId,
              snapshotSha256: snapshot.snapshotSha256,
              finalRunId: financialReportOfSnapshot(snapshot).finalRunId,
              actualCents: snapshot.report.cost.actualCents,
              financialReport: financialReportOfSnapshot(snapshot),
            });
            return operationId ? { kind: 'published' as const, ...old, operationId } : held('identity');
          }
          const media = p.media.consume(proof, snapshot);
          if (!media) return held('media');
          const created = await p.store.insert(scope, t, context.packet, snapshot, media);
          const operationId = await p.settlement.createInScope(scope, t.attemptId, {
            publicationId: created.publicationId,
            snapshotId: snapshot.snapshotId,
            snapshotSha256: snapshot.snapshotSha256,
            finalRunId: financialReportOfSnapshot(snapshot).finalRunId,
            actualCents: snapshot.report.cost.actualCents,
            financialReport: financialReportOfSnapshot(snapshot),
          });
          // Any refusal after admission must leave neither asset nor publication behind.
          if (!operationId) throw new Error('CUTROOM_PUBLICATION_SETTLEMENT_REQUIRED');
          return { kind: 'published' as const, ...created, operationId };
        });
        return committed.kind === 'entered' ? committed.value : held('review');
      } catch {
        return held('unavailable');
      }
    },
  };
}
