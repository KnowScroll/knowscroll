/** Loopback-only fake transport; request observations are fsynced by this separate process. */
import { createServer, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import pg from "pg";
import { durable, metadata } from "./reasoning-support.ts";
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const databaseUrl = new URL(process.env.DATABASE_URL!);
if (
  !["127.0.0.1", "localhost", "::1"].includes(databaseUrl.hostname) ||
  !/^\/knowscroll_j004_[0-9a-f]+$/.test(databaseUrl.pathname)
)
  throw Error("loopback disposable J004 database required");
const pending = new Map<string, ServerResponse>(),
  requests: any[] = [];
const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, pid: process.pid }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.from(c));
    const bytes = Buffer.concat(chunks);
    const attemptId = String(req.headers["x-attempt-id"]),
      requestId = String(req.headers["x-request-id"]),
      dispatchId = String(req.headers["x-dispatch-id"]),
      caseId = String(req.headers["x-case-id"]);
    const committedIntent = (
      await db.query(
        `SELECT a.*,p.state AS permit_state,p.dispatch_id AS permit_dispatch_id FROM reasoning_accounting a JOIN reasoning_permit p ON p.attempt_id=a.attempt_id WHERE a.attempt_id=$1`,
        [attemptId],
      )
    ).rows[0];
    if (
      !committedIntent ||
      committedIntent.dispatch_id !== dispatchId ||
      committedIntent.request_id !== requestId
    )
      throw Error("uncommitted_binding");
    const value = {
      caseId,
      pid: process.pid,
      observedAt: new Date().toISOString(),
      bodyHash: createHash("sha256").update(bytes).digest("hex"),
      attemptId,
      requestId,
      dispatchId,
      committedIntent,
    };
    requests.push(value);
    await durable(process.env.J004_EVENTS!, {
      event: "http_observed",
      pid: process.pid,
      at: value.observedAt,
      data: value,
    });
    pending.set(caseId, res);
    process.send?.({ type: "request", request: value });
  } catch {
    res.writeHead(500);
    res.end();
  }
});
process.on("message", (m: any) => {
  if (m.type !== "command") return;
  let result: any;
  if (m.operation === "release") {
    const res = pending.get(m.input.caseId);
    res?.setHeader("content-type", "application/json");
    res?.end(JSON.stringify(m.input.metadata ?? metadata));
    pending.delete(m.input.caseId);
    result = { released: !!res };
  } else if (m.operation === "requests") result = requests;
  process.send?.({ type: "result", id: m.id, result });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const a = server.address();
process.send?.({
  type: "ready",
  pid: process.pid,
  baseUrl: `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`,
});
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await db.end();
    process.exit(0);
  });
