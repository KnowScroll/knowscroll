/** Fixture-only J004 evidence. Rows are independently queried by the runner. */
export type SqlRow = Record<string, unknown>;
export type Snapshot = {
  label: string;
  at: string;
  universe: SqlRow[];
  job: SqlRow[];
  step: SqlRow[];
  attempt: SqlRow[];
  accounting: SqlRow[];
  permit: SqlRow[];
  reservations: SqlRow[];
  buckets: SqlRow[];
  receipts: SqlRow[];
  settlements: SqlRow[];
  adjustments: SqlRow[];
  contexts: SqlRow[];
  contextReads: SqlRow[];
  policyRows: SqlRow[];
  clearReceipts: SqlRow[];
};
export type ProcessEvidence = {
  role: string;
  pid: number;
  pgid: number;
  startedAt: string;
  readyAt?: string;
  exitCode: number | null;
  signal: string | null;
  exitedAt: string | null;
};
export type Barrier = {
  event: string;
  pid: number;
  at: string;
  data: Record<string, unknown>;
};
export type FixtureRequest = {
  caseId: string;
  pid: number;
  observedAt: string;
  bodyHash: string;
  attemptId: string;
  requestId: string;
  dispatchId: string;
  committedIntent: SqlRow;
};
export type CaseEvidence = {
  name: string;
  caseId: string;
  actorPids: number[];
  identities: Record<string, unknown>;
  barriers: Barrier[];
  fixtureCountBefore: number;
  fixtureCountAfter: number;
  snapshots: Snapshot[];
  operations: Array<{ name: string; result?: unknown; denial?: string }>;
};
export type ReasoningJourneyReceipt = {
  version: 1;
  journey: "J004";
  result: "passed" | "failed";
  source: {
    revision: string;
    dirty: boolean;
    files: Array<{ path: string; sha256: string }>;
  };
  database: { name: string; host: string; port: number };
  processes: ProcessEvidence[];
  fixture: { baseUrl: string; requests: FixtureRequest[] };
  cases: CaseEvidence[];
  cleanup: {
    databaseAbsent: boolean;
    processesExited: boolean;
    checkedAt: string;
  };
  error?: string;
};
export const J004_CASE_NAMES = [
  "death_before_intent",
  "death_after_intent",
  "death_after_http",
  "lost_commit_ack",
  "lease_replacement",
  "cancel_before_dispatch",
  "deadline_before_dispatch",
  "cancel",
  "deadline",
  "clear_late_receipt",
  "receipt_revisions",
  "capacity_contention",
  "blocked_universe",
] as const;
