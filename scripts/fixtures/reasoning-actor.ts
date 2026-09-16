/** Test-only separate-process actor; never loaded by the ordinary worker. */
import pg from "pg";
import { randomUUID } from "node:crypto";
import { createReasoningAdmission } from "../../packages/db/src/reasoning-admission.ts";
import { createReasoningReconciliation } from "../../packages/db/src/reasoning-reconciliation.ts";
import { invokeReasoningOnce } from "../../apps/worker/src/reasoning/invoke.ts";
import { authority, body, bodyHash, durable } from "./reasoning-support.ts";
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const databaseUrl = new URL(process.env.DATABASE_URL!);
if (
  !["127.0.0.1", "localhost", "::1"].includes(databaseUrl.hostname) ||
  !/^\/knowscroll_j004_[0-9a-f]+$/.test(databaseUrl.pathname)
)
  throw Error("loopback disposable J004 database required");
const admission = createReasoningAdmission(db, authority(db)),
  reconciliation = createReasoningReconciliation(db);
const barrier = async (event: string, data: Record<string, unknown>) => {
  const value = { event, pid: process.pid, at: new Date().toISOString(), data };
  await durable(process.env.J004_EVENTS!, value);
  process.send?.({ type: "barrier", ...value });
};
const pause = () => new Promise<never>(() => {});
const controllers = new Map<string, AbortController>();
process.on("message", async (raw: any) => {
  if (raw.type !== "command") return;
  const { id, operation, input } = raw;
  try {
    let result: unknown;
    if (operation === "abort") {
      controllers.get(input.caseId)?.abort();
      result = { aborted: true };
    } else if (operation === "reserve") {
      const claim =
        input.claim ??
        (await admission.claimJob({
          owner: input.owner,
          leaseMs: input.leaseMs ?? 60000,
        }));
      if (!claim || claim.jobId !== input.jobId)
        throw Error("unexpected_claim");
      const requestId = randomUUID();
      const deadline = new Date(
        Math.min(
          Date.now() + (input.deadlineMs ?? 45000),
          new Date(claim.leaseExpiresAt).getTime() + 40000,
        ),
      ).toISOString();
      const reserved = await admission.reserveAttempt({
        ...input,
        leaseFence: claim.leaseFence,
        requestId,
        requestHash: bodyHash,
        inputTokensUpperBound: body.byteLength,
        maxOutputTokens: 100,
        costCeilingMicroUsd: null,
        deadline,
        permitTtlMs: 45000,
      });
      result = {
        ...input,
        ...reserved,
        leaseFence: claim.leaseFence,
        requestId,
        requestHash: bodyHash,
        inputTokensUpperBound: body.byteLength,
        maxOutputTokens: 100,
        dispatchId: randomUUID(),
        deadline,
      };
      await barrier("reserved", result as any);
    } else if (operation === "invoke") {
      const wrapped = {
        authorizeDispatch: async (auth: any) => {
          const grant = await admission.authorizeDispatch(auth);
          await barrier("intent_committed", {
            caseId: input.caseId,
            attemptId: grant.attemptId,
            dispatchId: grant.dispatchId,
          });
          if (input.mode === "after_intent") await pause();
          if (input.mode === "lost_ack") throw Error("fixture_lost_commit_ack");
          return grant;
        },
        markAttemptUnknown: admission.markAttemptUnknown,
      };
      const controller = new AbortController();
      controllers.set(input.caseId, controller);
      result = await invokeReasoningOnce({
        admission: wrapped,
        reconciliation,
        authorization: input,
        body,
        signal: controller.signal,
        transport: {
          invoke: async ({ body: bytes, signal }) => {
            await barrier("transport_entered", { caseId: input.caseId });
            const response = await fetch(process.env.J004_FIXTURE_URL!, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-case-id": input.caseId,
                "x-attempt-id": input.attemptId,
                "x-request-id": input.requestId,
                "x-dispatch-id": input.dispatchId,
              },
              body: Buffer.from(bytes),
              signal,
              redirect: "error",
            });
            return response.json();
          },
        },
      });
      controllers.delete(input.caseId);
    } else if (operation === "recover")
      result = await admission.recoverAttempt(input);
    else if (operation === "authorize")
      result = await admission.authorizeDispatch(input);
    else if (operation === "withdraw")
      result = await admission.withdrawJob(input);
    else if (operation === "mark")
      result = await admission.markAttemptUnknown(input);
    else if (operation === "claim") result = await admission.claimJob(input);
    else if (operation === "receipt")
      result = await reconciliation.recordAndSettleReceipt(input, "reconciler");
    else throw Error("unknown_operation");
    await barrier("operation_finished", { operation, result });
    process.send?.({ type: "result", id, result });
  } catch (error) {
    const denial =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : error instanceof Error && error.message === "fixture_lost_commit_ack"
          ? "fixture_lost_commit_ack"
          : error instanceof Error && error.name === "ReasoningReceiptConflict"
            ? "receipt_conflict"
            : "actor_operation_failed";
    await barrier("operation_denied", { operation, denial });
    process.send?.({ type: "result", id, denial });
  }
});
process.send?.({ type: "ready", pid: process.pid });
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, async () => {
    await db.end();
    process.exit(0);
  });
