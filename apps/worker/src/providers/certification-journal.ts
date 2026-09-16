import {execFile} from 'node:child_process';
import {constants as fsConstants} from 'node:fs';
import {lstat, mkdir, open, readFile, readdir, realpath} from 'node:fs/promises';
import {basename, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {
  CERTIFICATION_LIMITS,
  type CertificationObservation,
  type DispatchMetadata,
} from './certification-contract.ts';

const execFileAsync = promisify(execFile);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const ATTEMPT_PATTERN = /^attempt-(\d{2})\.jsonl$/;
export const CERTIFICATION_CASES = ['json', 'tool-call', 'tool-continuation'] as const;
export type CertificationCase = typeof CERTIFICATION_CASES[number];

export type CaseChecks = Readonly<Record<string, boolean>>;
export type PublicUsage = CertificationObservation['usage'];

type RunPolicy = {
  version: 1;
  runId: string;
  live: boolean;
  maxRequests: number;
  maxReservedTokens: number;
  maxInputBytes: number;
  maxOutputTokens: number;
  requestTimeoutMs: number;
  runTimeoutMs: number;
};

type PreparedAttempt = {
  version: 1;
  record: 'prepared';
  attempt: number;
  caseId: CertificationCase;
  requestHash: string;
  inputBytes: number;
  maxOutputTokens: number;
  reservedUnits: number;
};

type ResolvedAttempt = {
  version: 1;
  record: 'resolved';
  outcome: CertificationObservation['outcome'];
  dispatched: boolean;
  httpStatus: number | null;
  providerRequestIdHash: string | null;
  responseContentHash: string | null;
  usage: PublicUsage;
  checks: CaseChecks;
};

export type PublicAttempt = PreparedAttempt & {
  status: 'unresolved' | CertificationObservation['outcome'];
  remoteOutcome: 'known' | 'unknown' | 'no_dispatch';
  dispatched: boolean | null;
  httpStatus: number | null;
  providerRequestIdHash: string | null;
  responseContentHash: string | null;
  usage: PublicUsage;
  checks: CaseChecks;
};

export type PublicCertificationReport = {
  version: 1;
  runId: string;
  live: boolean;
  limits: Omit<RunPolicy, 'version' | 'runId' | 'live'>;
  reservedUnits: number;
  attempts: PublicAttempt[];
};

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, fsConstants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeExclusive(path: string, value: unknown): Promise<void> {
  const handle = await open(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(resolve(path, '..'));
}

async function appendDurable(path: string, value: unknown): Promise<void> {
  const handle = await open(path, fsConstants.O_APPEND | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function assertInside(parent: string, child: string): void {
  const rel = relative(parent, child);
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
    throw new Error('Certification path must be a child of the checkout');
  }
}

async function ensureDirectoryWithoutSymlinks(path: string, stopAt: string): Promise<void> {
  assertInside(stopAt, path);
  const rel = relative(stopAt, path);
  let cursor = stopAt;
  for (const part of rel.split(sep)) {
    cursor = join(cursor, part);
    try {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe certification directory: ${cursor}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(cursor, {mode: 0o700});
    }
  }
}

async function assertDirectoryWithoutSymlinks(path: string, stopAt: string): Promise<void> {
  assertInside(stopAt, path);
  let cursor = stopAt;
  for (const part of relative(stopAt, path).split(sep)) {
    cursor = join(cursor, part);
    const stat = await lstat(cursor);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe certification directory: ${cursor}`);
  }
}

function remoteOutcome(resolved: ResolvedAttempt | undefined): PublicAttempt['remoteOutcome'] {
  if (!resolved) return 'unknown';
  if (!resolved.dispatched || resolved.outcome === 'not_dispatched') return 'no_dispatch';
  return resolved.outcome === 'completed' || resolved.outcome === 'http_error' ? 'known' : 'unknown';
}

async function assertIgnored(checkoutRoot: string, candidate: string): Promise<void> {
  try {
    await execFileAsync('git', ['check-ignore', '-q', '--', candidate], {cwd: checkoutRoot});
  } catch {
    throw new Error('Certification artifact parent is not ignored by Git');
  }
}

function emptyUsage(): PublicUsage {
  return {inputTokens:null, outputTokens:null, cacheReadTokens:null, cacheWriteTokens:null, costUsd:null};
}

function nullableCounter(value: number | null): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function sanitizeUsage(value: CertificationObservation['usage']): PublicUsage {
  return {
    inputTokens:nullableCounter(value.inputTokens),
    outputTokens:nullableCounter(value.outputTokens),
    cacheReadTokens:nullableCounter(value.cacheReadTokens),
    cacheWriteTokens:nullableCounter(value.cacheWriteTokens),
    costUsd:null,
  };
}

function sanitizeOutcome(value: CertificationObservation['outcome']): CertificationObservation['outcome'] {
  const allowed: CertificationObservation['outcome'][] = ['completed','http_error','invalid_response','aborted','timeout','transport_error','not_dispatched'];
  return allowed.includes(value) ? value : 'invalid_response';
}

function readResolved(value: unknown): ResolvedAttempt | undefined {
  if (!objectRecord(value) || value.version !== 1 || value.record !== 'resolved' || typeof value.dispatched !== 'boolean') return undefined;
  const allowed: CertificationObservation['outcome'][] = ['completed','http_error','invalid_response','aborted','timeout','transport_error','not_dispatched'];
  if (!allowed.includes(value.outcome as CertificationObservation['outcome'])) return undefined;
  const outcome = value.outcome as CertificationObservation['outcome'];
  const providerRequestIdHash = typeof value.providerRequestIdHash === 'string' && HASH_PATTERN.test(value.providerRequestIdHash) ? value.providerRequestIdHash : null;
  const responseContentHash = typeof value.responseContentHash === 'string' && HASH_PATTERN.test(value.responseContentHash) ? value.responseContentHash : null;
  const rawChecks = objectRecord(value.checks) ? Object.entries(value.checks).slice(0, 16) : [];
  const checks = Object.fromEntries(rawChecks.flatMap(([key, check]) =>
    /^[a-z][A-Za-z0-9]{0,47}$/.test(key) && typeof check === 'boolean' ? [[key, check]] : []));
  const usage = objectRecord(value.usage) ? sanitizeUsage({
    inputTokens:typeof value.usage.inputTokens === 'number' ? value.usage.inputTokens : null,
    outputTokens:typeof value.usage.outputTokens === 'number' ? value.usage.outputTokens : null,
    cacheReadTokens:typeof value.usage.cacheReadTokens === 'number' ? value.usage.cacheReadTokens : null,
    cacheWriteTokens:typeof value.usage.cacheWriteTokens === 'number' ? value.usage.cacheWriteTokens : null,
    costUsd:null,
  }) : emptyUsage();
  return {
    version:1,record:'resolved',outcome,dispatched:value.dispatched,
    httpStatus:Number.isInteger(value.httpStatus) && Number(value.httpStatus) >= 100 && Number(value.httpStatus) <= 599 ? Number(value.httpStatus) : null,
    providerRequestIdHash,responseContentHash,usage,checks,
  };
}

function objectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validatePrepared(value: unknown): asserts value is PreparedAttempt {
  const v = value as Partial<PreparedAttempt>;
  if (v.version !== 1 || v.record !== 'prepared' || !Number.isInteger(v.attempt) ||
      !CERTIFICATION_CASES.includes(v.caseId as CertificationCase) || !HASH_PATTERN.test(v.requestHash ?? '') ||
      !Number.isInteger(v.inputBytes) || !Number.isInteger(v.maxOutputTokens) || !Number.isInteger(v.reservedUnits)) {
    throw new Error('Invalid certification attempt journal');
  }
}

function validatePolicy(value: unknown): asserts value is RunPolicy {
  const v = value as Partial<RunPolicy>;
  if (v.version !== 1 || !UUID_PATTERN.test(v.runId ?? '') || typeof v.live !== 'boolean' ||
      !Number.isInteger(v.maxRequests) || !Number.isInteger(v.maxReservedTokens) ||
      !Number.isInteger(v.maxInputBytes) || !Number.isInteger(v.maxOutputTokens) ||
      !Number.isInteger(v.requestTimeoutMs) || !Number.isInteger(v.runTimeoutMs)) {
    throw new Error('Invalid certification policy');
  }
}

async function readCertificationRun(runDirectory: string): Promise<PublicCertificationReport> {
  const stat = await lstat(runDirectory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Unsafe certification run path');
  const policy = JSON.parse(await readFile(join(runDirectory, 'policy.json'), 'utf8')) as unknown;
  validatePolicy(policy);
  if (policy.runId !== basename(runDirectory)) throw new Error('Certification policy does not match its run directory');
  if (resolve(runDirectory, '..', '..') === resolve(runDirectory)) throw new Error('Unsafe certification run path');
  const names = (await readdir(runDirectory)).filter((name) => ATTEMPT_PATTERN.test(name)).sort();
  const attempts: PublicAttempt[] = [];
  for (const name of names) {
    const fileStat = await lstat(join(runDirectory, name));
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) throw new Error('Unsafe certification attempt path');
    const lines = (await readFile(join(runDirectory, name), 'utf8')).trim().split('\n');
    if (lines.length < 1 || lines.length > 2) throw new Error('Invalid certification attempt journal');
    const prepared = JSON.parse(lines[0]!) as unknown;
    validatePrepared(prepared);
    const fileAttempt = Number(ATTEMPT_PATTERN.exec(name)?.[1]);
    if (prepared.attempt !== fileAttempt || prepared.reservedUnits !== prepared.inputBytes + prepared.maxOutputTokens ||
        prepared.inputBytes <= 0 || prepared.inputBytes > policy.maxInputBytes ||
        prepared.maxOutputTokens <= 0 || prepared.maxOutputTokens > policy.maxOutputTokens) {
      throw new Error('Certification attempt does not match its durable reservation');
    }
    let resolved: ResolvedAttempt | undefined;
    if (lines[1]) {
      try { resolved = readResolved(JSON.parse(lines[1])) ; } catch { resolved = undefined; }
    }
    attempts.push({
      version:1,
      record:'prepared',
      attempt:prepared.attempt,
      caseId:prepared.caseId,
      requestHash:prepared.requestHash,
      inputBytes:prepared.inputBytes,
      maxOutputTokens:prepared.maxOutputTokens,
      reservedUnits:prepared.reservedUnits,
      status: resolved?.outcome ?? 'unresolved',
      remoteOutcome: remoteOutcome(resolved),
      dispatched: resolved?.dispatched ?? null,
      httpStatus: resolved?.httpStatus ?? null,
      providerRequestIdHash: resolved?.providerRequestIdHash ?? null,
      responseContentHash: resolved?.responseContentHash ?? null,
      usage: resolved?.usage ?? emptyUsage(),
      checks: resolved?.checks ?? {},
    });
  }
  if (attempts.some((attempt, index) => attempt.attempt !== index + 1) || attempts.length > policy.maxRequests ||
      attempts.reduce((sum, attempt) => sum + attempt.reservedUnits, 0) > policy.maxReservedTokens) {
    throw new Error('Certification journal exceeds its durable policy');
  }
  return {
    version: 1,
    runId: policy.runId,
    live: policy.live,
    limits: {
      maxRequests: policy.maxRequests,
      maxReservedTokens: policy.maxReservedTokens,
      maxInputBytes: policy.maxInputBytes,
      maxOutputTokens: policy.maxOutputTokens,
      requestTimeoutMs: policy.requestTimeoutMs,
      runTimeoutMs: policy.runTimeoutMs,
    },
    reservedUnits: attempts.reduce((sum, attempt) => sum + attempt.reservedUnits, 0),
    attempts,
  };
}

export async function inspectCertificationRun(checkoutRoot: string, runDirectory: string): Promise<PublicCertificationReport> {
  const root = await realpath(checkoutRoot);
  const artifactRoot = join(root, 'artifacts', 'minimax-certification');
  assertInside(artifactRoot, resolve(runDirectory));
  if (!UUID_PATTERN.test(basename(runDirectory)) || resolve(runDirectory, '..') !== artifactRoot) {
    throw new Error('Certification run must be a UUID directory under the ignored artifact root');
  }
  await assertIgnored(root, relative(root, runDirectory));
  await assertDirectoryWithoutSymlinks(runDirectory, root);
  return readCertificationRun(runDirectory);
}

export class CertificationJournal {
  readonly runId: string;
  readonly runDirectory: string;
  #reservedUnits = 0;
  #attempts = 0;
  #activeAttempt: {path:string; number:number} | null = null;

  private constructor(runId: string, runDirectory: string) {
    this.runId = runId;
    this.runDirectory = runDirectory;
  }

  static async create(checkoutRoot: string, live: boolean, runId = randomUUID()): Promise<CertificationJournal> {
    if (!UUID_PATTERN.test(runId)) throw new Error('Run id must be a UUID v4');
    const root = await realpath(checkoutRoot);
    const artifactRoot = join(root, 'artifacts', 'minimax-certification');
    assertInside(root, artifactRoot);
    await assertIgnored(root, join('artifacts', 'minimax-certification', '.probe'));
    await ensureDirectoryWithoutSymlinks(artifactRoot, root);
    const runDirectory = join(artifactRoot, runId);
    await mkdir(runDirectory, {mode: 0o700});
    const runHandle = await open(runDirectory, fsConstants.O_RDONLY);
    try { await runHandle.chmod(0o700); await runHandle.sync(); } finally { await runHandle.close(); }
    await syncDirectory(artifactRoot);
    const policy: RunPolicy = {version:1, runId, live, ...CERTIFICATION_LIMITS};
    await writeExclusive(join(runDirectory, 'policy.json'), policy);
    return new CertificationJournal(runId, runDirectory);
  }

  beforeDispatch(caseId: CertificationCase): (metadata: DispatchMetadata) => Promise<void> {
    let called = false;
    return async (metadata) => {
      if (called) throw new Error('Dispatch reservation callback may run only once');
      called = true;
      if (this.#activeAttempt) throw new Error('Certification attempts must run serially');
      if (!HASH_PATTERN.test(metadata.requestHash)) throw new Error('Invalid request hash');
      if (!Number.isInteger(metadata.inputBytes) || metadata.inputBytes <= 0 || metadata.inputBytes > CERTIFICATION_LIMITS.maxInputBytes) {
        throw new Error('Serialized request exceeds the certification byte limit');
      }
      if (!Number.isInteger(metadata.maxOutputTokens) || metadata.maxOutputTokens <= 0 || metadata.maxOutputTokens > CERTIFICATION_LIMITS.maxOutputTokens) {
        throw new Error('Output reservation exceeds the certification limit');
      }
      const attempt = this.#attempts + 1;
      const reservedUnits = metadata.inputBytes + metadata.maxOutputTokens;
      if (attempt > CERTIFICATION_LIMITS.maxRequests) throw new Error('Certification request limit exhausted');
      if (this.#reservedUnits + reservedUnits > CERTIFICATION_LIMITS.maxReservedTokens) throw new Error('Certification token reservation exhausted');
      const path = join(this.runDirectory, `attempt-${String(attempt).padStart(2, '0')}.jsonl`);
      const prepared: PreparedAttempt = {version:1, record:'prepared', attempt, caseId, ...metadata, reservedUnits};
      await writeExclusive(path, prepared);
      this.#attempts = attempt;
      this.#reservedUnits += reservedUnits;
      this.#activeAttempt = {path, number:attempt};
    };
  }

  async resolve(observation: CertificationObservation, checks: CaseChecks): Promise<void> {
    const active = this.#activeAttempt;
    if (!active) throw new Error('No prepared certification attempt to resolve');
    if (observation.requestHash !== null) {
      const report = await readCertificationRun(this.runDirectory);
      const prepared = report.attempts.find((attempt) => attempt.attempt === active.number);
      if (!prepared || prepared.requestHash !== observation.requestHash) throw new Error('Adapter observation request hash does not match reservation');
    }
    const providerRequestIdHash = observation.providerRequestId === null || observation.providerRequestId.length > 256
      ? null
      : (await import('node:crypto')).createHash('sha256').update(observation.providerRequestId).digest('hex');
    const responseContentHash = observation.outcome === 'completed'
      ? (await import('node:crypto')).createHash('sha256').update(JSON.stringify({nativeContent:observation.nativeContent,text:observation.text})).digest('hex')
      : null;
    const resolved: ResolvedAttempt = {
      version:1,
      record:'resolved',
      outcome:sanitizeOutcome(observation.outcome),
      dispatched:observation.dispatched,
      httpStatus:Number.isInteger(observation.httpStatus) && observation.httpStatus! >= 100 && observation.httpStatus! <= 599 ? observation.httpStatus : null,
      providerRequestIdHash,
      responseContentHash,
      usage:sanitizeUsage(observation.usage),
      checks:Object.fromEntries(Object.entries(checks).map(([key, value]) => {
        if (!/^[a-z][A-Za-z0-9]{0,47}$/.test(key)) throw new Error('Invalid public check name');
        return [key, Boolean(value)];
      })),
    };
    await appendDurable(active.path, resolved);
    this.#activeAttempt = null;
  }

  inspect(): Promise<PublicCertificationReport> { return readCertificationRun(this.runDirectory); }
}
