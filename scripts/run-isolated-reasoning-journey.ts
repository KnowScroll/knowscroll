/** J004 disposable separate-process fault runner. Local fixtures only. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer as createNetServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import pg from "pg";
import { runMigrations } from "../packages/db/src/migrations.ts";
import { trackPoolDisconnect } from "./lib/pg-disconnect.ts";
import {
  body,
  bodyHash,
  metadata,
  seed,
  snapshot,
} from "./fixtures/reasoning-support.ts";
import {
  J004_CASE_NAMES,
  type Barrier,
  type CaseEvidence,
  type FixtureRequest,
  type ProcessEvidence,
  type ReasoningJourneyReceipt,
} from "./fixtures/reasoning-evidence.ts";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Map<string, string | true>();
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i]!;
  if (
    k === "--pause-for-interrupt" ||
    k === "--inject-pool-error-before-interrupt" ||
    k === "--inject-pool-error-after-interrupt"
  )
    args.set(k, true);
  else {
    const v = process.argv[++i];
    if (!v) throw Error(`missing ${k}`);
    args.set(k, v);
  }
}
const suffix = randomBytes(8).toString("hex"),
  dbName = `knowscroll_j004_${suffix}`,
  receiptPath = resolve(
    String(args.get("--receipt") ?? `artifacts/j004-${suffix}.json`),
  ),
  manifestPath = resolve(
    String(args.get("--manifest") ?? `artifacts/j004-manifest-${suffix}.json`),
  ),
  eventsPath = resolve(`artifacts/j004-events-${suffix}.jsonl`);
const processes: ProcessEvidence[] = [],
  children = new Set<ChildProcess>(),
  barriers: Barrier[] = [],
  fixtureRequests: FixtureRequest[] = [],
  cases: CaseEvidence[] = [];
let interrupted = false,
  created = false,
  ready = false,
  admin: pg.Client | undefined,
  db: pg.Pool | undefined,
  poolDisconnect: ReturnType<typeof trackPoolDisconnect> | undefined,
  temp = "";
const atomic = async (path: string, value: unknown) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2));
  await rename(`${path}.tmp`, path);
};
type FailureClassification =
  | "interrupted"
  | "child_process_exit"
  | "pool_runtime_error"
  | "journey_failure"
  | "cleanup_failure";
type FailurePhase = "runtime" | "cleanup";
type SecondaryCondition = {
  classification: FailureClassification;
  phase: FailurePhase;
};
type CleanupStage =
  | "children"
  | "pool"
  | "pool_disconnect"
  | "database"
  | "admin"
  | "temporary_directory"
  | "complete";
class ClassifiedFailure extends Error {
  constructor(readonly classification: FailureClassification) {
    super(classification);
  }
}
let failure: unknown,
  failureClassification: FailureClassification | undefined,
  failurePhase: FailurePhase | undefined;
let diagnosticPhase: FailurePhase = "runtime";
type PoolErrorEvidence = {
  origin: "admin_client" | "db_pool";
  phase: FailurePhase;
  cleanupStage: CleanupStage | "not_started";
  sqlState: "57P01" | "unknown";
};
let cleanupStage: CleanupStage | "not_started" = "not_started";
let firstPoolError: PoolErrorEvidence | undefined;
const observePoolError = (origin: PoolErrorEvidence["origin"], error: unknown) => {
  firstPoolError ??= {
    origin,
    phase: diagnosticPhase,
    cleanupStage,
    sqlState:
      error && typeof error === "object" && "code" in error &&
      (error as { code?: unknown }).code === "57P01"
        ? "57P01"
        : "unknown",
  };
};
const secondaryConditions: SecondaryCondition[] = [];
const observeFailure = (
  classification: FailureClassification,
  phase: FailurePhase = diagnosticPhase,
) => {
  if (!failureClassification) {
    failureClassification = classification;
    failurePhase = phase;
    return;
  }
  if (
    classification !== failureClassification &&
    !secondaryConditions.some(
      (condition) => condition.classification === classification,
    )
  ) {
    secondaryConditions.push({ classification, phase });
  }
};
const failureDiagnostic = (cleanupErrors: string[]) =>
  failureClassification && failurePhase
    ? {
        classification: failureClassification,
        phase: failurePhase,
        secondaryConditions: [...secondaryConditions],
        cleanupErrors: [...cleanupErrors],
        ...(firstPoolError === undefined ? {} : { poolError: firstPoolError }),
      }
    : undefined;
const manifest = async (
  cleanedUp?: boolean,
  diagnostic?: {
    classification: FailureClassification;
    phase: FailurePhase;
    secondaryConditions: SecondaryCondition[];
    cleanupErrors: string[];
    poolError?: PoolErrorEvidence;
  },
  cleanupStage?: CleanupStage,
) =>
  atomic(manifestPath, {
    journey: "J004",
    database: source
      ? {
          host: new URL(source).hostname,
          port: Number(new URL(source).port || 5432),
          name: dbName,
        }
      : { host: "unknown", port: 0, name: dbName },
    runnerPid: process.pid,
    processes: processes.map(({ role, pid, pgid, readyAt }) => ({
      role,
      pid,
      pgid,
      readyAt,
    })),
    apiBase,
    fixtureBase: fixtureUrl,
    ready,
    ...(cleanedUp === undefined ? {} : { cleanedUp }),
    ...(diagnostic === undefined ? {} : { diagnostic }),
    ...(cleanupStage === undefined ? {} : { cleanupStage }),
  });
let source = "";
try {
  const env = process.env.DATABASE_URL;
  let local: string | undefined;
  try {
    local = Object.fromEntries(
      (await readFile(resolve(root, ".env"), "utf8"))
        .split("\n")
        .flatMap((x) => {
          const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(x);
          return m ? [[m[1], m[2]]] : [];
        }),
    ).DATABASE_URL;
  } catch {}
  source = env ?? local ?? "";
} catch {}
if (
  !source ||
  !["127.0.0.1", "localhost", "::1"].includes(new URL(source).hostname)
)
  throw Error("J004 requires loopback DATABASE_URL");
const dbUrl = (name: string) => {
  const u = new URL(source);
  u.pathname = `/${name}`;
  return u.toString();
};
const quote = (x: string) => `"${x.replaceAll('"', '""')}"`;
const allowed = () => {
  const keys = [
    "PATH",
    "HOME",
    "LANG",
    "LC_ALL",
    "KS_DEV_ROOT",
    "npm_config_cache",
    "COREPACK_HOME",
    "TMPDIR",
  ];
  return Object.fromEntries(
    keys.flatMap((k) =>
      process.env[k] === undefined ? [] : [[k, process.env[k]!]],
    ),
  );
};
type Peer = {
  child: ChildProcess;
  role: string;
  readyData: any;
  call: (operation: string, input?: any) => Promise<any>;
  wait: (event: string, caseId?: string) => Promise<Barrier>;
};
async function peer(
  role: string,
  module: string,
  extra: Record<string, string> = {},
): Promise<Peer> {
  if (interrupted) throw Error("interrupted");
  const child = spawn(
    process.execPath,
    [
      "--import",
      resolve(root, "node_modules/tsx/dist/loader.mjs"),
      resolve(root, module),
    ],
    {
      cwd: temp,
      env: {
        ...allowed(),
        DATABASE_URL: dbUrl(dbName),
        NODE_ENV: "test",
        J004_EVENTS: eventsPath,
        ...extra,
      },
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      detached: true,
    },
  );
  if (!child.pid) {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  }
  if (!child.pid) throw Error(`${role} process has no pid`);
  children.add(child);
  const evidence: ProcessEvidence = {
    role,
    pid: child.pid,
    pgid: child.pid,
    startedAt: new Date().toISOString(),
    exitCode: null,
    signal: null,
    exitedAt: null,
  };
  processes.push(evidence);
  let sequence = 0;
  const pending = new Map<
    number,
    { ok: (value: any) => void; bad: (error: Error) => void }
  >();
  const waiters: Array<{
    event: string;
    caseId?: string;
    ok: (barrier: Barrier) => void;
    bad: (error: Error) => void;
  }> = [];
  let readyResolve!: (value: any) => void;
  let readyReject!: (error: Error) => void;
  const readyPromise = new Promise<any>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const childExited = (message: string) => {
    const error = Error(message);
    readyReject(error);
    for (const item of pending.values()) item.bad(error);
    pending.clear();
    for (const waiter of waiters) waiter.bad(error);
    waiters.length = 0;
  };
  child.on("error", (error) =>
    childExited(`${role} spawn failed: ${error.name}`),
  );
  child.on("exit", (code, signal) => {
    children.delete(child);
    evidence.exitCode = code;
    evidence.signal = signal;
    evidence.exitedAt = new Date().toISOString();
    if (
      args.has("--pause-for-interrupt") &&
      !interrupted &&
      diagnosticPhase === "runtime"
    ) {
      failure ??= new ClassifiedFailure("child_process_exit");
      observeFailure("child_process_exit");
    }
    childExited(`${role} exited`);
  });
  child.on("message", (message: any) => {
    if (message.type === "ready") readyResolve(message);
    if (message.type === "barrier") {
      const barrier = {
        event: message.event,
        pid: message.pid,
        at: message.at,
        data: message.data,
      };
      barriers.push(barrier);
      for (const waiter of [...waiters])
        if (
          waiter.event === barrier.event &&
          (!waiter.caseId || waiter.caseId === barrier.data.caseId)
        ) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.ok(barrier);
        }
    }
    if (message.type === "request") {
      fixtureRequests.push(message.request);
      const barrier = {
        event: "http_observed",
        pid: message.request.pid,
        at: message.request.observedAt,
        data: message.request,
      };
      barriers.push(barrier);
      for (const waiter of [...waiters])
        if (
          waiter.event === barrier.event &&
          (!waiter.caseId || waiter.caseId === barrier.data.caseId)
        ) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.ok(barrier);
        }
    }
    if (message.type === "result") {
      const item = pending.get(message.id);
      if (item) {
        pending.delete(message.id);
        item.ok(message.denial ? { denial: message.denial } : message.result);
      }
    }
  });
  const bounded = <T>(promise: Promise<T>, label: string) =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error(`${role} ${label} timeout`)),
        10000,
      );
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  const readyData = await bounded(readyPromise, "ready");
  evidence.readyAt = new Date().toISOString();
  return {
    child,
    role,
    readyData,
    call: (operation, input = {}) =>
      bounded(
        new Promise((ok, bad) => {
          const id = ++sequence;
          pending.set(id, { ok, bad });
          child.send({ type: "command", id, operation, input });
        }),
        `call ${operation}`,
      ),
    wait: (event, caseId) => {
      const found = barriers.find(
        (barrier) =>
          barrier.event === event &&
          (!caseId || barrier.data.caseId === caseId),
      );
      return found
        ? Promise.resolve(found)
        : bounded(
            new Promise((ok, bad) => waiters.push({ event, caseId, ok, bad })),
            `barrier ${event}`,
          );
    },
  };
}
async function stop(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM") {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
  const waitForExit = (rejectOnTimeout: boolean) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.off("exit", exited);
        if (rejectOnTimeout) reject(Error(`child ${child.pid} did not exit`));
        else resolve();
      }, 3000);
      const exited = () => {
        clearTimeout(timer);
        resolve();
      };
      child.once("exit", exited);
    });
  await waitForExit(false);
  if (child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
    await waitForExit(true);
  }
}
async function withTimeout<T>(operation: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Error(label)), milliseconds);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
function groupAlive(pgid: number): boolean {
  try { process.kill(-pgid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}
async function removeRemainingGroups() {
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    for (const evidence of processes) {
      if (!groupAlive(evidence.pgid)) continue;
      try { process.kill(-evidence.pgid, signal); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    for (let i = 0; i < 30 && processes.some(p => groupAlive(p.pgid)); i++)
      await new Promise(resolve => setTimeout(resolve, 100));
    if (processes.every(p => !groupAlive(p.pgid))) return;
  }
  throw Error("process_group_still_present");
}
async function unusedLoopbackPort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw Error("no API port");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
const onSignal = () => {
  // Test-only ordering barrier. The checker sends a real signal after readiness;
  // this routes a synthetic condition through the real Pool listener before the
  // signal observation is latched. It makes no claim about the retained CI run.
  if (db && args.has("--inject-pool-error-before-interrupt"))
    db.emit("error", new Error("injected_pool_error_before_interrupt"));
  interrupted = true;
  failure ??= new ClassifiedFailure("interrupted");
  observeFailure("interrupted");
  for (const child of children) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null)
      continue;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {}
    }
  }
};
// Keep both handlers installed through the final cleanup manifest. Repeated
// termination requests are idempotent and must not restore the default signal
// action before cleanup acknowledgement is durable.
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);
function newCase(name: string, ids: any): CaseEvidence {
  const c = {
    name,
    caseId: `${name}-${randomUUID()}`,
    actorPids: [],
    identities: ids,
    barriers: [],
    fixtureCountBefore: fixtureRequests.length,
    fixtureCountAfter: 0,
    snapshots: [],
    operations: [],
  };
  cases.push(c);
  return c;
}
async function actor(role: string, fixtureUrl: string) {
  const a = await peer(role, "scripts/fixtures/reasoning-actor.ts", {
    J004_FIXTURE_URL: fixtureUrl,
  });
  await manifest();
  return a;
}
async function reserve(
  a: Peer,
  g: any,
  c: CaseEvidence,
  owner: string,
  deadlineMs = 45000,
  leaseMs = 60000,
) {
  c.actorPids.push(a.child.pid!);
  const r = await a.call("reserve", {
    ...g,
    policy: undefined,
    owner,
    deadlineMs,
    leaseMs,
  });
  if (r.denial) throw Error(r.denial);
  Object.assign(c.identities, r, { policy: g.policy });
  c.barriers.push(...barriers.filter((b) => b.pid === a.child.pid));
  c.snapshots.push(await snapshot(db!, "reserved", c.identities));
  return { ...r, caseId: c.caseId };
}
async function waitLeaseExpiry(jobId: string) {
  for (let i = 0; i < 500; i++) {
    const row = (
      await db!.query<{ expired: boolean }>(
        "SELECT lease_expires_at<=clock_timestamp() AS expired FROM reasoning_job WHERE id=$1",
        [jobId],
      )
    ).rows[0];
    if (row?.expired) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw Error("lease expiry timeout");
}
const receiptTimes = new Map<string, string>();
async function lateReceipt(
  a: Peer,
  x: any,
  id = randomUUID(),
  usageValue: any = metadata.usage,
  remoteDisposition = "terminal",
) {
  if (!receiptTimes.has(id)) receiptTimes.set(id, new Date().toISOString());
  return a.call("receipt", {
    version: 1,
    receiptId: id,
    attemptId: x.attemptId,
    requestId: x.requestId,
    dispatchId: x.dispatchId,
    routeId: "local-fixture",
    routeProfileVersion: "j004-v1",
    evidenceKind: "operator_reconciliation",
    observedAt: receiptTimes.get(id),
    remoteDisposition,
    outcome: "success",
    httpStatus: 200,
    usage: usageValue,
  });
}
async function runCase(name: string, fn: (c: CaseEvidence) => Promise<void>) {
  const c = newCase(name, {});
  await fn(c);
  for (const operation of c.operations) {
    const value = operation.result as any;
    if (value?.denial) {
      operation.denial = value.denial;
      delete operation.result;
    }
  }
  c.fixtureCountAfter = fixtureRequests.length;
  c.barriers = barriers.filter(
    (b) => b.data.caseId === c.caseId || c.actorPids.includes(b.pid),
  );
}
let fixture: Peer | undefined,
  fixtureUrl = "",
  apiBase = "";
const cleanupErrors: string[] = [];
let poolRuntimeError = false;
try {
  temp = await mkdtemp(resolve(tmpdir(), "knowscroll-j004-"));
  await atomic(manifestPath, {
    journey: "J004",
    database: {
      host: new URL(source).hostname,
      port: Number(new URL(source).port || 5432),
      name: dbName,
    },
    runnerPid: process.pid,
    processes: [],
    ready: false,
  });
  admin = new pg.Client({ connectionString: dbUrl("postgres") });
  admin.on("error", (error) => {
    observePoolError("admin_client", error);
    poolRuntimeError = true;
    failure ??= new ClassifiedFailure("pool_runtime_error");
    observeFailure("pool_runtime_error");
  });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${quote(dbName)}`);
  created = true;
  await manifest();
  db = new pg.Pool({
    connectionString: dbUrl(dbName),
    max: 20,
    application_name: "knowscroll-j004-runner",
  });
  poolDisconnect = trackPoolDisconnect(db);
  // node-postgres emits idle-client failures through the Pool's EventEmitter.
  // Without a listener, Node treats the event as an uncaught exception and can
  // exit before the cleanup manifest or database drop. Keep the evidence
  // bounded: record only the typed condition, never the error or connection.
  db.on("error", (error) => {
    observePoolError("db_pool", error);
    poolRuntimeError = true;
    failure ??= new ClassifiedFailure("pool_runtime_error");
    observeFailure("pool_runtime_error");
  });
  await runMigrations(db, {
    directory: resolve(root, "packages/db/migrations"),
  });
  await db.query(
    "INSERT INTO universe(id) VALUES('00000000-0000-4000-8000-000000000001')",
  );
  await db.query(
    "INSERT INTO accounts(universe_id) VALUES('00000000-0000-4000-8000-000000000001')",
  );
  await db.query(
    "CREATE TABLE j004_policy(job_id uuid PRIMARY KEY REFERENCES reasoning_job(id) ON DELETE CASCADE,policy jsonb NOT NULL)",
  );
  fixture = await peer("fixture", "scripts/fixtures/reasoning-server.ts");
  fixtureUrl = fixture.readyData.baseUrl;
  // API is a real existing API process; its readiness is checked later for the clear case.
  const apiPort = await unusedLoopbackPort();
  const apiChild = spawn(
    process.execPath,
    [
      "--import",
      resolve(root, "node_modules/tsx/dist/loader.mjs"),
      resolve(root, "apps/api/src/main.ts"),
    ],
    {
      cwd: temp,
      env: {
        ...allowed(),
        DATABASE_URL: dbUrl(dbName),
        NODE_ENV: "test",
        PORT: String(apiPort),
        KS_DEV_TOKEN: randomBytes(32).toString("hex"),
      },
      stdio: "inherit",
      detached: true,
    },
  );
  if (!apiChild.pid) {
    await new Promise<void>((resolve, reject) => {
      apiChild.once("spawn", resolve);
      apiChild.once("error", reject);
    });
  }
  if (!apiChild.pid) throw Error("API process has no pid");
  children.add(apiChild);
  const apiEvidence: ProcessEvidence = {
    role: "api",
    pid: apiChild.pid,
    pgid: apiChild.pid,
    startedAt: new Date().toISOString(),
    exitCode: null,
    signal: null,
    exitedAt: null,
  };
  processes.push(apiEvidence);
  apiChild.on("exit", (code, signal) => {
    children.delete(apiChild);
    apiEvidence.exitCode = code;
    apiEvidence.signal = signal;
    apiEvidence.exitedAt = new Date().toISOString();
    if (
      args.has("--pause-for-interrupt") &&
      !interrupted &&
      diagnosticPhase === "runtime"
    ) {
      failure ??= new ClassifiedFailure("child_process_exit");
      observeFailure("child_process_exit");
    }
  });
  let apiSpawnError: Error | undefined;
  apiChild.on("error", (error) => {
    apiSpawnError = error;
  });
  apiBase = `http://127.0.0.1:${apiPort}`;
  for (let i = 0; i < 100; i++) {
    if (interrupted) throw Error("interrupted");
    if (apiSpawnError || apiEvidence.exitedAt)
      throw Error("API exited before readiness");
    try {
      const response = await fetch(`${apiBase}/health`, {signal: AbortSignal.timeout(2000)});
      if (response.ok) {
        const health = (await response.json()) as { status?: string };
        if (health.status === "ok") {
          apiEvidence.readyAt = new Date().toISOString();
          break;
        }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!apiEvidence.readyAt) throw Error("API not ready");
  const probe = await actor("worker-ready", fixtureUrl);
  ready = true;
  await manifest();
  if (args.has("--pause-for-interrupt")) {
    while (!interrupted && !poolRuntimeError && children.has(probe.child))
      await new Promise((r) => setTimeout(r, 50));
    if (failureClassification)
      throw new ClassifiedFailure(failureClassification);
    if (!interrupted) throw new ClassifiedFailure("child_process_exit");
    throw new ClassifiedFailure("interrupted");
  }
  await runCase("death_before_intent", async (c) => {
    const g = await seed(db!);
    Object.assign(c.identities, g);
    const a = await actor("worker-before-intent", fixtureUrl),
      x = await reserve(a, g, c, "worker-before", 45000, 1500);
    await stop(a.child, "SIGKILL");
    await waitLeaseExpiry(g.jobId);
    const r = await actor("worker-recovery-before", fixtureUrl);
    c.actorPids.push(r.child.pid!);
    c.operations.push({
      name: "recover",
      result: await r.call("recover", { ...x, owner: "recovery" }),
    });
    c.snapshots.push(await snapshot(db!, "recovered_not_sent", c.identities));
    await stop(r.child);
  });
  await runCase("death_after_intent", async (c) => {
    const g = await seed(db!);
    Object.assign(c.identities, g);
    const a = await actor("worker-after-intent", fixtureUrl),
      x = await reserve(a, g, c, "worker-intent", 45000, 1500);
    void a
      .call("invoke", { ...x, mode: "after_intent" })
      .catch(() => undefined);
    await a.wait("intent_committed", c.caseId);
    await stop(a.child, "SIGKILL");
    await waitLeaseExpiry(g.jobId);
    const r = await actor("worker-recovery-intent", fixtureUrl);
    c.actorPids.push(r.child.pid!);
    c.operations.push({
      name: "recover",
      result: await r.call("recover", { ...x, owner: "recovery" }),
    });
    c.operations.push({
      name: "retry_authorize",
      result: await r.call("authorize", x),
    });
    c.snapshots.push(await snapshot(db!, "unknown_no_request", c.identities));
    await stop(r.child);
  });
  await runCase("death_after_http", async (c) => {
    const g = await seed(db!);
    Object.assign(c.identities, g);
    const a = await actor("worker-after-http", fixtureUrl),
      x = await reserve(a, g, c, "worker-http", 45000, 1500);
    void a.call("invoke", x).catch(() => undefined);
    await fixture!.wait("http_observed", c.caseId);
    await stop(a.child, "SIGKILL");
    await waitLeaseExpiry(g.jobId);
    const r = await actor("worker-recovery-http", fixtureUrl);
    c.actorPids.push(r.child.pid!);
    c.operations.push({
      name: "recover",
      result: await r.call("recover", { ...x, owner: "recovery" }),
    });
    c.operations.push({
      name: "retry_authorize",
      result: await r.call("authorize", x),
    });
    c.snapshots.push(await snapshot(db!, "recovered_unknown", c.identities));
    c.operations.push({
      name: "late_receipt",
      result: await lateReceipt(r, x),
    });
    c.snapshots.push(await snapshot(db!, "late_usage_settled", c.identities));
    await stop(r.child);
  });
  await runCase("lost_commit_ack", async (c) => {
    const g = await seed(db!);
    Object.assign(c.identities, g);
    const a = await actor("worker-lost-ack", fixtureUrl),
      x = await reserve(a, g, c, "worker-ack", 45000, 1500);
    c.operations.push({
      name: "invoke",
      result: await a.call("invoke", { ...x, mode: "lost_ack" }),
    });
    c.snapshots.push(
      await snapshot(db!, "intent_without_transport_grant", c.identities),
    );
    c.operations.push({
      name: "original_retry_authorize",
      result: await a.call("authorize", x),
    });
    await stop(a.child);
    await waitLeaseExpiry(g.jobId);
    const replacement = await actor("worker-lost-ack-recovery", fixtureUrl);
    c.actorPids.push(replacement.child.pid!);
    c.operations.push({
      name: "recover",
      result: await replacement.call("recover", { ...x, owner: "recovery" }),
    });
    c.operations.push({
      name: "replacement_retry_authorize",
      result: await replacement.call("authorize", x),
    });
    c.snapshots.push(
      await snapshot(db!, "lost_ack_recovered_unknown", c.identities),
    );
    await stop(replacement.child);
  });
  await runCase("lease_replacement", async (c) => {
    const g = await seed(db!);
    Object.assign(c.identities, g);
    const a = await actor("worker-lease-a", fixtureUrl),
      x = await reserve(a, g, c, "lease-a", 45000, 1500);
    c.snapshots.push(await snapshot(db!, "before_lease_b", c.identities));
    await waitLeaseExpiry(g.jobId);
    const replacement = await actor("worker-lease-b-recovery", fixtureUrl);
    c.actorPids.push(replacement.child.pid!);
    c.operations.push({
      name: "lease_b_recovery",
      result: await replacement.call("recover", { ...x, owner: "lease-b" }),
    });
    c.operations.push({
      name: "stale_a_authorize",
      result: await a.call("authorize", x),
    });
    c.operations.push({
      name: "stale_a_mark",
      result: await a.call("mark", { ...x, reason: "local_cancel" }),
    });
    c.snapshots.push(
      await snapshot(db!, "recovery_fence_stale_a_denied", c.identities),
    );
    await stop(a.child);
    await stop(replacement.child);
  });
  for (const name of [
    "cancel_before_dispatch",
    "deadline_before_dispatch",
  ] as const)
    await runCase(name, async (c) => {
      const deadline = name === "deadline_before_dispatch";
      const g = await seed(db!, { deadlineMs: deadline ? 5000 : 60000 });
      Object.assign(c.identities, g);
      const a = await actor(`worker-${name}`, fixtureUrl),
        x = await reserve(
          a,
          g,
          c,
          `worker-${name}`,
          deadline ? 5000 : 45000,
          deadline ? 10000 : 5000,
        );
      if (deadline) {
        for (let i = 0; i < 500; i++) {
          const expired = (
            await db!.query<{ expired: boolean }>(
              "SELECT deadline<=clock_timestamp() AS expired FROM reasoning_job WHERE id=$1",
              [g.jobId],
            )
          ).rows[0]?.expired;
          if (expired) break;
          await new Promise((r) => setTimeout(r, 10));
        }
      }
      c.operations.push({
        name: "withdraw_before_dispatch",
        result: await a.call("withdraw", {
          ...x,
          reason: deadline ? "expired" : "cancelled",
        }),
      });
      c.snapshots.push(
        await snapshot(
          db!,
          deadline ? "deadline_not_sent" : "cancel_not_sent",
          c.identities,
        ),
      );
      await stop(a.child);
    });
  for (const name of ["cancel", "deadline"] as const)
    await runCase(name, async (c) => {
      const g = await seed(db!, {
        deadlineMs: name === "deadline" ? 2500 : 60000,
      });
      Object.assign(c.identities, g);
      const a = await actor(`worker-${name}`, fixtureUrl),
        x = await reserve(
          a,
          g,
          c,
          `worker-${name}`,
          name === "deadline" ? 1800 : 45000,
        );
      const pending = a.call("invoke", {
        ...x,
        mode: name === "cancel" ? "cancel" : undefined,
      });
      await fixture!.wait("http_observed", c.caseId);
      if (name === "cancel") await a.call("abort", { caseId: c.caseId });
      if (name === "deadline") await new Promise((r) => setTimeout(r, 2200));
      c.operations.push({ name: "invoke", result: await pending });
      c.snapshots.push(await snapshot(db!, `${name}_unknown`, c.identities));
      c.operations.push({
        name: "late_receipt",
        result: await lateReceipt(a, x),
      });
      c.snapshots.push(await snapshot(db!, `${name}_late_usage`, c.identities));
      await stop(a.child);
    });
  await runCase("clear_late_receipt", async (c) => {
    const g = await seed(db!);
    Object.assign(c.identities, g);
    const token = randomBytes(32).toString("base64url"),
      sessionId = randomUUID(),
      deviceId = randomUUID();
    await db!.query(
      `INSERT INTO device_session(id,universe_id,device_id,token_hash,privacy_epoch,expires_at) VALUES($1,$2,$3,$4,0,clock_timestamp()+interval '1 hour')`,
      [
        sessionId,
        g.universeId,
        deviceId,
        createHash("sha256").update(token).digest("hex"),
      ],
    );
    const a = await actor("worker-clear", fixtureUrl),
      x = await reserve(a, g, c, "worker-clear");
    const pending = a.call("invoke", x);
    await fixture!.wait("http_observed", c.caseId);
    const clearId = randomUUID(),
      clear = await fetch(`http://127.0.0.1:${apiPort}/v1/history/clear`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          requestId: clearId,
          expectedPrivacyEpoch: 0,
          confirmation: "clear-scroll-history",
        }),
      });
    const clearJson = await clear.json();
    if (clear.status !== 200) throw Error("clear HTTP failed");
    c.operations.push({
      name: "api_clear",
      result: { status: clear.status, body: clearJson },
    });
    c.snapshots.push(
      await snapshot(db!, "cleared_response_paused", c.identities),
    );
    await fixture!.call("release", { caseId: c.caseId });
    c.operations.push({ name: "delayed_invocation", result: await pending });
    c.snapshots.push(await snapshot(db!, "late_usage_settled", c.identities));
    const later = await seed(db!, { universeId: g.universeId, epoch: 1 });
    const laterReserved = await a.call("reserve", {
      ...later,
      policy: undefined,
      owner: "worker-later",
    });
    if (laterReserved.denial) throw Error("later reservation denied");
    const before = await snapshot(db!, "later_activity_before_clear_replay", {
      ...later,
      attemptId: laterReserved.attemptId,
    });
    const replay = await fetch(`http://127.0.0.1:${apiPort}/v1/history/clear`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        requestId: clearId,
        expectedPrivacyEpoch: 0,
        confirmation: "clear-scroll-history",
      }),
    });
    const replayJson = await replay.json();
    if (
      replay.status !== 200 ||
      JSON.stringify(replayJson) !== JSON.stringify(clearJson)
    )
      throw Error("clear replay mismatch");
    c.operations.push({
      name: "old_clear_replay",
      result: { status: replay.status, body: replayJson },
    });
    c.snapshots.push(
      before,
      await snapshot(db!, "old_clear_replay_preserved_later", {
        ...later,
        attemptId: x.attemptId,
      }),
    );
    await a.call("withdraw", { ...laterReserved, reason: "cancelled" });
    await stop(a.child);
  });
  await runCase("receipt_revisions", async (c) => {
    const g = await seed(db!);
    Object.assign(c.identities, g);
    const a = await actor("worker-receipts", fixtureUrl),
      x = await reserve(a, g, c, "worker-receipts");
    void a
      .call("invoke", { ...x, mode: "after_intent" })
      .catch(() => undefined);
    await a.wait("intent_committed", c.caseId);
    await stop(a.child, "SIGKILL");
    const r = await actor("worker-reconciler-receipts", fixtureUrl),
      receiptId = randomUUID();
    c.actorPids.push(r.child.pid!);
    c.operations.push({
      name: "nullable",
      result: await lateReceipt(
        r,
        x,
        receiptId,
        {
          inputTokens: 7,
          outputTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          costMicroUsd: null,
        },
        "unconfirmed",
      ),
    });
    c.snapshots.push(await snapshot(db!, "first_usage", c.identities));
    c.operations.push({
      name: "duplicate",
      result: await lateReceipt(
        r,
        x,
        receiptId,
        {
          inputTokens: 7,
          outputTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          costMicroUsd: null,
        },
        "unconfirmed",
      ),
    });
    c.snapshots.push(await snapshot(db!, "duplicate_usage", c.identities));
    c.operations.push({
      name: "terminal_unknown",
      result: await lateReceipt(r, x, randomUUID(), {
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        costMicroUsd: null,
      }),
    });
    c.snapshots.push(
      await snapshot(db!, "terminal_unknown_usage", c.identities),
    );
    c.operations.push({
      name: "cumulative",
      result: await lateReceipt(r, x, randomUUID(), {
        inputTokens: 9,
        outputTokens: 3,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        costMicroUsd: null,
      }),
    });
    c.snapshots.push(await snapshot(db!, "cumulative_usage", c.identities));
    c.operations.push({
      name: "revised",
      result: await lateReceipt(r, x, randomUUID(), {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        costMicroUsd: null,
      }),
    });
    c.snapshots.push(await snapshot(db!, "revised_usage", c.identities));
    c.operations.push({
      name: "overage",
      result: await lateReceipt(r, x, randomUUID(), {
        inputTokens: 200,
        outputTokens: 5,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        costMicroUsd: null,
      }),
    });
    c.snapshots.push(await snapshot(db!, "overage_usage", c.identities));
    c.operations.push({
      name: "conflict",
      result: await lateReceipt(
        r,
        x,
        receiptId,
        {
          inputTokens: 8,
          outputTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          costMicroUsd: null,
        },
        "unconfirmed",
      ),
    });
    c.snapshots.push(await snapshot(db!, "conflicting_usage", c.identities));
    c.operations.push({
      name: "decreasing",
      result: await lateReceipt(r, x, randomUUID(), {
        inputTokens: 8,
        outputTokens: 2,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        costMicroUsd: null,
      }),
    });
    c.snapshots.push(
      await snapshot(db!, "decreasing_usage_frozen", c.identities),
    );
    await stop(r.child);
  });
  await runCase("capacity_contention", async (c) => {
    const shared = Object.fromEntries(
        [
          "global_budget",
          "provider_account",
          "route_quota",
          "remote_concurrency",
        ].map((k) => [k, randomUUID()]),
      ),
      g1 = await seed(db!, { shared, capacity: 200 }),
      g2 = await seed(db!, { shared, capacity: 200 });
    Object.assign(c.identities, g1, { secondUniverseId: g2.universeId });
    const a = await actor("worker-capacity-a", fixtureUrl),
      b = await actor("worker-capacity-b", fixtureUrl);
    c.actorPids.push(a.child.pid!, b.child.pid!);
    const claimA = await a.call("claim", { owner: "cap-a", leaseMs: 60000 }),
      claimB = await b.call("claim", { owner: "cap-b", leaseMs: 60000 });
    const outcomes = await Promise.all([
      a.call("reserve", {
        ...g1,
        policy: undefined,
        owner: "cap-a",
        claim: claimA,
      }),
      b.call("reserve", {
        ...g2,
        policy: undefined,
        owner: "cap-b",
        claim: claimB,
      }),
    ]);
    c.operations.push({ name: "concurrent_reserve", result: outcomes });
    c.snapshots.push(
      await snapshot(db!, "one_capacity_winner", c.identities),
      await snapshot(db!, "second_capacity_contender", g2),
    );
    await stop(a.child);
    await stop(b.child);
  });
  await runCase("blocked_universe", async (c) => {
    const blocked = await seed(db!),
      available = await seed(db!);
    Object.assign(c.identities, available, {
      blockedUniverseId: blocked.universeId,
    });
    const lock = await db!.connect();
    let a: Peer | undefined;
    try {
    await lock.query("BEGIN");
    await lock.query("SELECT id FROM universe WHERE id=$1 FOR UPDATE", [
      blocked.universeId,
    ]);
    c.operations.push({
      name: "blocked_before",
      result: (
        await lock.query(
          "SELECT id,status,lease_fence,lease_owner FROM reasoning_job WHERE id=$1",
          [blocked.jobId],
        )
      ).rows,
    });
    a = await actor("worker-skip-locked", fixtureUrl);
    c.actorPids.push(a.child.pid!);
    c.operations.push({
      name: "claim",
      result: await a.call("claim", { owner: "skip-worker", leaseMs: 5000 }),
    });
    c.operations.push({
      name: "blocked_after",
      result: {
        observedAt: new Date().toISOString(),
        rows: (
          await lock.query(
            "SELECT id,status,lease_fence,lease_owner FROM reasoning_job WHERE id=$1",
            [blocked.jobId],
          )
        ).rows,
      },
    });
    } finally {
      try { await lock.query("ROLLBACK"); } finally { lock.release(); }
    }
    c.snapshots.push(
      await snapshot(db!, "other_universe_progress", c.identities),
    );
    if (a) await stop(a.child);
  });
  const byName = new Map(cases.map((value) => [value.name, value]));
  const count = (name: string) => {
    const value = byName.get(name)!;
    return value.fixtureCountAfter - value.fixtureCountBefore;
  };
  for (const name of [
    "death_before_intent",
    "death_after_intent",
    "lost_commit_ack",
    "lease_replacement",
    "cancel_before_dispatch",
    "deadline_before_dispatch",
    "receipt_revisions",
    "capacity_contention",
    "blocked_universe",
  ])
    assert.equal(count(name), 0, `${name} fixture count`);
  for (const name of [
    "death_after_http",
    "cancel",
    "deadline",
    "clear_late_receipt",
  ])
    assert.equal(count(name), 1, `${name} fixture count`);
  for (const name of [
    "death_before_intent",
    "death_after_intent",
    "death_after_http",
    "receipt_revisions",
  ])
    assert.ok(
      byName
        .get(name)!
        .actorPids.some((pid) =>
          processes.some(
            (process) =>
              process.pid === pid &&
              process.signal === "SIGKILL" &&
              process.exitedAt,
          ),
        ),
      `${name} SIGKILL evidence`,
    );
  for (const [name, label, state] of [
    ["death_before_intent", "recovered_not_sent", "not_sent"],
    ["death_after_intent", "unknown_no_request", "unknown"],
    ["cancel_before_dispatch", "cancel_not_sent", "not_sent"],
    ["deadline_before_dispatch", "deadline_not_sent", "not_sent"],
  ] as const) {
    const snap = byName
      .get(name)!
      .snapshots.find((value) => value.label === label)!;
    assert.equal(snap.accounting[0]?.state, state);
  }
  const clearCase = byName.get("clear_late_receipt")!;
  const cleared = clearCase.snapshots.find(
    (value) => value.label === "cleared_response_paused",
  )!;
  assert.equal(cleared.universe[0]?.privacy_epoch, 1);
  assert.equal(
    cleared.job.length +
      cleared.step.length +
      cleared.attempt.length +
      cleared.contexts.length +
      cleared.contextReads.length +
      cleared.policyRows.length,
    0,
  );
  const late = clearCase.snapshots.find(
    (value) => value.label === "late_usage_settled",
  )!;
  assert.equal(late.accounting[0]?.state, "responded");
  assert.equal(late.accounting[0]?.output_authority, "withdrawn");
  const capacity = byName
    .get("capacity_contention")!
    .operations.find((value) => value.name === "concurrent_reserve")!
    .result as any[];
  assert.equal(
    capacity.filter((value) => value.denial === "insufficient_capacity").length,
    1,
  );
  assert.equal(capacity.filter((value) => value.attemptId).length, 1);
  const blockedCase = byName.get("blocked_universe")!;
  assert.equal(
    (
      blockedCase.operations.find((value) => value.name === "claim")!
        .result as any
    ).jobId,
    blockedCase.identities.jobId,
  );
  for (const c of cases) {
    for (const op of c.operations) {
      const result = op.result as any;
      if (
        op.denial &&
        ![
          "fixture_lost_commit_ack",
          "stale_lease",
          "dispatch_already_decided",
          "receipt_conflict",
          "attempt_not_active",
          "attempt_not_dispatched",
        ].includes(op.denial)
      )
        throw Error("unexpected denial");
      if (op.denial === "receipt_conflict" && op.name !== "conflict")
        throw Error("unexpected actor failure");
    }
  }
  if (cases.map((c) => c.name).join("|") !== J004_CASE_NAMES.join("|"))
    throw Error("case matrix incomplete");
} catch (error) {
  failure ??= error;
  const caughtClassification = error instanceof ClassifiedFailure
    ? error.classification
    : interrupted
      ? "interrupted"
      : poolRuntimeError
        ? "pool_runtime_error"
      : "journey_failure";
  observeFailure(caughtClassification);
} finally {
  ready = false;
  diagnosticPhase = "cleanup";
  cleanupStage = "children";
  // Test-only ordering barrier: the real signal handler has already latched the
  // primary cause. Emit through the real Pool listener during cleanup so the
  // checker can prove that a later pool condition cannot replace it. This does
  // not claim the retained CI event had the same origin or ordering.
  if (
    interrupted &&
    db &&
    args.has("--inject-pool-error-after-interrupt")
  )
    db.emit("error", new Error("injected_pool_error_after_interrupt"));
  const cleanupCheckpoint = async (stage: CleanupStage) => {
    cleanupStage = stage;
    try {
      await manifest(
        undefined,
        failureDiagnostic(cleanupErrors),
        stage,
      );
    } catch {
      // The final manifest write below remains the authoritative acknowledgement.
    }
  };
  await cleanupCheckpoint("children");
  const stopped = await Promise.allSettled(
    [...children].map((child) => stop(child)),
  );
  if (stopped.some((result) => result.status === "rejected"))
    cleanupErrors.push("child_stop_failed");
  try { await removeRemainingGroups(); } catch { cleanupErrors.push("process_group_cleanup_failed"); }
  await cleanupCheckpoint("pool");
  if (db) {
    try {
      await withTimeout(db.end(), 3000, "pool_close_timeout");
    } catch {
      cleanupErrors.push("pool_close_failed");
    }
  }
  await cleanupCheckpoint("pool_disconnect");
  if (poolDisconnect && admin) {
    try {
      const disconnected = await withTimeout(
        poolDisconnect.wait(admin, dbName),
        3000,
        "pool_disconnect_timeout",
      );
      if (!disconnected) cleanupErrors.push("pool_disconnect_failed");
    } catch {
      cleanupErrors.push("pool_disconnect_failed");
    }
  }
  await cleanupCheckpoint("database");
  if (admin && created) {
    try {
      await withTimeout(admin.query(
        `DROP DATABASE IF EXISTS ${quote(dbName)}`,
      ), 5000, "database_drop_timeout");
    } catch {
      cleanupErrors.push("database_drop_graceful_failed");
      try {
        await withTimeout(admin.query(
          `DROP DATABASE IF EXISTS ${quote(dbName)} WITH (FORCE)`,
        ), 5000, "database_force_drop_timeout");
      } catch {
        cleanupErrors.push("database_drop_force_failed");
      }
    }
    try {
      const remaining = (
        await admin.query("SELECT datname FROM pg_database WHERE datname=$1", [
          dbName,
        ])
      ).rowCount;
      if (remaining) cleanupErrors.push("database_still_present");
      else created = false;
    } catch {
      cleanupErrors.push("database_verify_failed");
    }
  }
  await cleanupCheckpoint("admin");
  if (admin) {
    try {
      await withTimeout(admin.end(), 3000, "admin_close_timeout");
    } catch {
      cleanupErrors.push("admin_close_failed");
    }
  }
  await cleanupCheckpoint("temporary_directory");
  if (temp) {
    try {
      await rm(temp, { recursive: true, force: true });
    } catch {
      cleanupErrors.push("temporary_directory_cleanup_failed");
    }
  }
  const processesExited = processes.every((evidence) => {
    if (!evidence.exitedAt) return false;
    try {
      process.kill(-evidence.pgid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  });
  if (!processesExited) cleanupErrors.push("process_group_still_present");
  const cleanedUp = !created && processesExited && cleanupErrors.length === 0;
  if (cleanupErrors.length > 0) {
    failure ??= new ClassifiedFailure("cleanup_failure");
    observeFailure("cleanup_failure");
  }
  try {
    await manifest(
      cleanedUp,
      failureDiagnostic(cleanupErrors),
      "complete",
    );
  } catch {
    cleanupErrors.push("manifest_write_failed");
  }
  if (cleanupErrors.length > 0) {
    failure ??= new ClassifiedFailure("cleanup_failure");
    observeFailure("cleanup_failure");
  }
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
}
const sourceEvidence = {
  revision: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim(),
  dirty:
    execFileSync("git", ["status", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
    }).trim() !== "",
  files: await Promise.all(
    [
      "scripts/run-isolated-reasoning-journey.ts",
      "scripts/lib/pg-disconnect.ts",
      "scripts/fixtures/reasoning-actor.ts",
      "scripts/fixtures/reasoning-server.ts",
      "scripts/fixtures/reasoning-support.ts",
      "scripts/fixtures/reasoning-evidence.ts",
      "packages/db/src/reasoning-runtime-policy.ts",
      "packages/db/src/reasoning-admission.ts",
      "packages/db/src/reasoning-reconciliation.ts",
      "apps/worker/src/reasoning/invoke.ts",
      "packages/db/src/privacy.ts",
      "apps/api/src/app.ts",
      "packages/db/migrations/0004_reasoning_storage.sql",
      "packages/db/migrations/0005_reasoning_runtime.sql",
    ].map(async (path) => ({
      path,
      sha256: createHash("sha256")
        .update(await readFile(resolve(root, path)))
        .digest("hex"),
    })),
  ),
};
const receipt: ReasoningJourneyReceipt = {
  version: 1,
  journey: "J004",
  result: failure ? "failed" : "passed",
  source: sourceEvidence,
  database: {
    name: dbName,
    host: new URL(source).hostname,
    port: Number(new URL(source).port || 5432),
  },
  processes,
  fixture: { baseUrl: fixtureUrl, requests: fixtureRequests },
  cases,
  cleanup: {
    databaseAbsent: !created,
    processesExited:
      cleanupErrors.includes("process_group_still_present") === false &&
      processes.every((p) => p.exitedAt !== null),
    checkedAt: new Date().toISOString(),
  },
  ...(failure
    ? { error: failureClassification === "interrupted" ? "interrupted" : "j004_failed" }
    : {}),
};
await atomic(receiptPath, receipt);
console.log(
  JSON.stringify({
    journey: "J004",
    result: receipt.result,
    receiptPath,
    manifestPath,
    cases: cases.length,
  }),
);
if (failure)
  throw Error(
    failureClassification === "interrupted" ? "J004 interrupted" : "J004 failed",
  );
