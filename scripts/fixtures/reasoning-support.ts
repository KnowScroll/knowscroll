import { randomUUID, createHash } from "node:crypto";
import { open } from "node:fs/promises";
import type pg from "pg";
import type {
  ReasoningAuthority,
  ResolvedReasoningPolicy,
} from "../../packages/db/src/reasoning-runtime-policy.ts";
import type { Snapshot } from "./reasoning-evidence.ts";
export const usage = {
  inputTokens: 7,
  outputTokens: 3,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  costMicroUsd: null,
};
export const metadata = {
  remoteDisposition: "terminal",
  outcome: "success",
  httpStatus: 200,
  usage,
};
export const body = Buffer.from('{"synthetic":"J004"}');
export const bodyHash = createHash("sha256").update(body).digest("hex");
export async function durable(path: string, event: unknown) {
  const file = await open(path, "a", 0o600);
  try {
    await file.writeFile(JSON.stringify(event) + "\n");
    await file.sync();
  } finally {
    await file.close();
  }
}
export function authority(db: pg.Pool): ReasoningAuthority {
  return {
    resolvePolicy: async (client, scope) =>
      (
        await client.query("SELECT policy FROM j004_policy WHERE job_id=$1", [
          scope.jobId,
        ])
      ).rows[0]?.policy,
    validateContext: async (client, scope) =>
      !!(
        await client.query(
          "SELECT id FROM reasoning_context WHERE id=$1 AND job_id=$2 AND universe_id=$3 AND privacy_epoch=$4 FOR SHARE",
          [scope.contextId, scope.jobId, scope.universeId, scope.privacyEpoch],
        )
      ).rowCount,
  };
}
export async function seed(
  db: pg.Pool,
  options: {
    universeId?: string;
    epoch?: number;
    shared?: Record<string, string>;
    capacity?: number;
    deadlineMs?: number;
  } = {},
) {
  const universeId = options.universeId ?? randomUUID(),
    epoch = options.epoch ?? 0,
    jobId = randomUUID(),
    stepId = randomUUID(),
    contextId = randomUUID();
  await db.query(
    "INSERT INTO universe(id,privacy_epoch) VALUES($1,$2) ON CONFLICT DO NOTHING",
    [universeId, epoch],
  );
  await db.query(
    "INSERT INTO accounts(universe_id) VALUES($1) ON CONFLICT DO NOTHING",
    [universeId],
  );
  await db.query(
    `INSERT INTO reasoning_job(id,universe_id,privacy_epoch,status,class,budget_owner_id,policy_version,deadline,wake_kind,intent_id) VALUES($1,$2,$3,'queued','interactive',$2,'j004-v1',clock_timestamp()+($4::bigint*interval '1 millisecond'),'direct',$5)`,
    [jobId, universeId, epoch, options.deadlineMs ?? 60000, randomUUID()],
  );
  await db.query(
    `INSERT INTO reasoning_context(id,job_id,universe_id,privacy_epoch,content_hash,policy_version,source_policy_version) VALUES($1,$2,$3,$4,$5,'j004-v1','j004-v1')`,
    [contextId, jobId, universeId, epoch, "a".repeat(64)],
  );
  await db.query(
    `INSERT INTO reasoning_context_read(context_id,universe_id,privacy_epoch,kind,scope_kind,scope_universe_id,entity_key,revision) VALUES($1,$2,$3,'source','public',NULL,$4,1)`,
    [contextId, universeId, epoch, `j004:${contextId}`],
  );
  await db.query(
    `INSERT INTO reasoning_step(id,job_id,universe_id,privacy_epoch,context_id,ordinal,status) VALUES($1,$2,$3,$4,$5,1,'pending')`,
    [stepId, jobId, universeId, epoch, contextId],
  );
  const dimensions = [
    "global_budget",
    "owner_budget",
    "job_budget",
    "provider_account",
    "route_quota",
    "remote_concurrency",
  ] as const;
  const policy: ResolvedReasoningPolicy = {
    version: 1,
    routeId: "local-fixture",
    routeProfileVersion: "j004-v1",
    policyVersion: "j004-v1",
    maxInputTokens: 1000,
    maxOutputTokens: 1000,
    priceBasis: null,
    requiredDimensions: [...dimensions],
    buckets: dimensions.map((d) => ({
      bucketId: options.shared?.[d] ?? randomUUID(),
      dimension: d,
      unit: d === "remote_concurrency" ? "slots" : "tokens",
      windowId: null,
      scope:
        d === "owner_budget" ? "owner" : d === "job_budget" ? "job" : "shared",
      scopeId:
        d === "owner_budget" ? universeId : d === "job_budget" ? jobId : null,
      basis: d === "remote_concurrency" ? "remote_slots" : "total_tokens",
      handling: d === "remote_concurrency" ? "remote" : "budget",
    })),
  };
  for (const b of policy.buckets)
    await db.query(
      "INSERT INTO reasoning_bucket(id,dimension,unit,capacity) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
      [b.bucketId, b.dimension, b.unit, options.capacity ?? 10000],
    );
  await db.query("INSERT INTO j004_policy(job_id,policy) VALUES($1,$2)", [
    jobId,
    policy,
  ]);
  return { universeId, privacyEpoch: epoch, jobId, stepId, contextId, policy };
}
export async function snapshot(
  db: pg.Pool,
  label: string,
  ids: Record<string, unknown>,
): Promise<Snapshot> {
  const u = ids.universeId,
    a = ids.attemptId,
    j = ids.jobId,
    b =
      (ids.policy as ResolvedReasoningPolicy | undefined)?.buckets.map(
        (x) => x.bucketId,
      ) ?? [];
  const query = async (sql: string, args: unknown[]) =>
    (await db.query(sql, args)).rows;
  return {
    label,
    at: new Date().toISOString(),
    universe: await query("SELECT * FROM universe WHERE id=$1", [u]),
    job: await query(
      "SELECT * FROM reasoning_job WHERE universe_id=$1 ORDER BY id",
      [u],
    ),
    step: await query(
      "SELECT * FROM reasoning_step WHERE universe_id=$1 ORDER BY id",
      [u],
    ),
    attempt: await query(
      "SELECT * FROM reasoning_attempt WHERE universe_id=$1 ORDER BY id",
      [u],
    ),
    accounting: await query(
      "SELECT * FROM reasoning_accounting WHERE universe_id=$1 ORDER BY attempt_id",
      [u],
    ),
    permit: await query(
      "SELECT * FROM reasoning_permit WHERE universe_id=$1 ORDER BY id",
      [u],
    ),
    reservations: await query(
      "SELECT * FROM reasoning_reservation WHERE attempt_id IN (SELECT attempt_id FROM reasoning_accounting WHERE universe_id=$1) ORDER BY bucket_id",
      [u],
    ),
    buckets: await query(
      "SELECT * FROM reasoning_bucket WHERE id=ANY($1::uuid[]) ORDER BY id",
      [b],
    ),
    receipts: await query(
      "SELECT * FROM reasoning_receipt WHERE attempt_id IN (SELECT attempt_id FROM reasoning_accounting WHERE universe_id=$1) ORDER BY observed_at,id",
      [u],
    ),
    settlements: await query(
      "SELECT * FROM reasoning_settlement WHERE attempt_id IN (SELECT attempt_id FROM reasoning_accounting WHERE universe_id=$1) ORDER BY revision,id",
      [u],
    ),
    adjustments: await query(
      "SELECT * FROM reasoning_settlement_adjustment WHERE attempt_id IN (SELECT attempt_id FROM reasoning_accounting WHERE universe_id=$1) ORDER BY settlement_id,bucket_id",
      [u],
    ),
    contexts: await query(
      "SELECT * FROM reasoning_context WHERE universe_id=$1 ORDER BY id",
      [u],
    ),
    contextReads: await query(
      "SELECT * FROM reasoning_context_read WHERE universe_id=$1 ORDER BY context_id,kind,entity_key",
      [u],
    ),
    policyRows: await query(
      "SELECT * FROM j004_policy WHERE job_id=ANY(SELECT id FROM reasoning_job WHERE universe_id=$1)",
      [u],
    ),
    clearReceipts: await query(
      "SELECT * FROM history_clear_receipt WHERE universe_id=$1 ORDER BY request_id",
      [u],
    ),
  };
}
