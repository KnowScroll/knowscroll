import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, stat, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {
  CertificationJournal,
  inspectCertificationRun,
} from '../apps/worker/src/providers/certification-journal.ts';
import type {CertificationObservation} from '../apps/worker/src/providers/certification-contract.ts';

const execFileAsync = promisify(execFile);
const HASH = 'a'.repeat(64);

async function checkout(ignored = true): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'knowscroll-certification-'));
  await execFileAsync('git', ['init', '-q'], {cwd:root});
  if (ignored) await writeFile(join(root, '.gitignore'), 'artifacts/\n', {mode:0o600});
  return root;
}

function observation(overrides: Partial<CertificationObservation> = {}): CertificationObservation {
  return {
    outcome:'completed', dispatched:true, httpStatus:200, requestHash:HASH, providerRequestId:'untrusted-provider-id',
    usage:{inputTokens:null,outputTokens:null,cacheReadTokens:null,cacheWriteTokens:null,costUsd:null},
    nativeContent:[], text:'secret output', stopReason:'end_turn', ...overrides,
  };
}

test('journal durably prepares a private exclusive attempt before resolving it', async () => {
  const root = await checkout();
  const runId = '00000000-0000-4000-8000-000000000001';
  const journal = await CertificationJournal.create(root, false, runId);
  assert.equal((await stat(journal.runDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(journal.runDirectory, 'policy.json'))).mode & 0o777, 0o600);

  const reserve = journal.beforeDispatch('json');
  await reserve({requestHash:HASH,inputBytes:321,maxOutputTokens:512});
  const attemptPath = join(journal.runDirectory, 'attempt-01.jsonl');
  assert.equal((await stat(attemptPath)).mode & 0o777, 0o600);
  const prepared = await inspectCertificationRun(root, journal.runDirectory);
  assert.equal(prepared.reservedUnits, 833);
  assert.equal(prepared.attempts[0]?.status, 'unresolved');
  assert.equal(prepared.attempts[0]?.dispatched, null);

  await journal.resolve(observation({
    stopReason:'SENTINEL_SECRET_STOP',
    usage:{inputTokens:-4,outputTokens:Number.NaN,cacheReadTokens:2,cacheWriteTokens:null,costUsd:null},
  }), {jsonParsed:true, schemaValid:true});
  const resolved = await journal.inspect();
  assert.equal(resolved.attempts[0]?.status, 'completed');
  assert.match(resolved.attempts[0]?.providerRequestIdHash ?? '', /^[0-9a-f]{64}$/);
  const persisted = await readFile(attemptPath, 'utf8');
  assert.doesNotMatch(persisted, /secret output|untrusted-provider-id|SENTINEL_SECRET_STOP/);
  assert.equal(resolved.attempts[0]?.usage.inputTokens, null);
  assert.equal(resolved.attempts[0]?.usage.outputTokens, null);
});

test('journal refuses replay, parallel attempts, excess bounds and an existing run', async () => {
  const root = await checkout();
  const runId = '00000000-0000-4000-8000-000000000002';
  const journal = await CertificationJournal.create(root, true, runId);
  const reserve = journal.beforeDispatch('tool-call');
  await reserve({requestHash:HASH,inputBytes:100,maxOutputTokens:2048});
  await assert.rejects(reserve({requestHash:HASH,inputBytes:100,maxOutputTokens:2048}), /only once/);
  await assert.rejects(journal.beforeDispatch('json')({requestHash:HASH,inputBytes:100,maxOutputTokens:512}), /serially/);
  await assert.rejects(CertificationJournal.create(root, true, runId), /EEXIST/);
  await journal.resolve(observation(), {toolCallValid:true});
  await assert.rejects(journal.beforeDispatch('json')({requestHash:HASH,inputBytes:16_385,maxOutputTokens:512}), /byte limit/);
  await assert.rejects(journal.beforeDispatch('json')({requestHash:HASH,inputBytes:100,maxOutputTokens:4097}), /Output reservation/);
});

test('journal enforces the aggregate reservation and request ceilings without refunds', async () => {
  const root = await checkout();
  const journal = await CertificationJournal.create(root, false);
  for (let index = 0; index < 4; index += 1) {
    await journal.beforeDispatch('json')({requestHash:String(index).repeat(64),inputBytes:100,maxOutputTokens:512});
    await journal.resolve(observation({requestHash:String(index).repeat(64),outcome:'transport_error'}), {jsonParsed:false});
  }
  await assert.rejects(journal.beforeDispatch('json')({requestHash:HASH,inputBytes:100,maxOutputTokens:512}), /request limit/);
  assert.equal((await journal.inspect()).reservedUnits, 4 * 612);
});

test('journal rejects non-ignored and symlinked artifact parents', async () => {
  const visible = await checkout(false);
  await assert.rejects(CertificationJournal.create(visible, false), /not ignored/);

  const linked = await checkout();
  const elsewhere = await mkdtemp(join(tmpdir(), 'knowscroll-certification-target-'));
  await mkdir(join(linked, 'artifacts'));
  await symlink(elsewhere, join(linked, 'artifacts', 'minimax-certification'));
  await assert.rejects(CertificationJournal.create(linked, false), /not ignored|Unsafe certification directory/);
});

test('inspection preserves a prepared attempt as unresolved and does not mutate it', async () => {
  const root = await checkout();
  const journal = await CertificationJournal.create(root, false);
  await journal.beforeDispatch('tool-continuation')({requestHash:HASH,inputBytes:900,maxOutputTokens:2048});
  const before = await readFile(join(journal.runDirectory, 'attempt-01.jsonl'), 'utf8');
  const report = await inspectCertificationRun(root, journal.runDirectory);
  const after = await readFile(join(journal.runDirectory, 'attempt-01.jsonl'), 'utf8');
  assert.equal(report.attempts[0]?.status, 'unresolved');
  assert.equal(after, before);
});

test('inspection treats a torn final append as unknown and never exposes its fragment', async () => {
  const root = await checkout();
  const journal = await CertificationJournal.create(root, false);
  await journal.beforeDispatch('json')({requestHash:HASH,inputBytes:100,maxOutputTokens:512});
  const path = join(journal.runDirectory, 'attempt-01.jsonl');
  const handle = await (await import('node:fs/promises')).open(path, 'a');
  await handle.write('{"version":1,"record":"resolved","providerRequestIdHash":"SENTINEL');
  await handle.close();
  const report = await inspectCertificationRun(root, journal.runDirectory);
  assert.equal(report.attempts[0]?.status, 'unresolved');
  assert.equal(report.attempts[0]?.remoteOutcome, 'unknown');
  assert.doesNotMatch(JSON.stringify(report), /SENTINEL/);
});

test('inspection constructs its whitelist and drops extra fields from parsed disk records', async () => {
  const root = await checkout();
  const journal = await CertificationJournal.create(root, false);
  await journal.beforeDispatch('json')({requestHash:HASH,inputBytes:100,maxOutputTokens:512});
  const path = join(journal.runDirectory, 'attempt-01.jsonl');
  const prepared = JSON.parse((await readFile(path, 'utf8')).trim()) as Record<string, unknown>;
  prepared.SENTINEL_SECRET_FIELD = 'must-not-roundtrip';
  await writeFile(path, `${JSON.stringify(prepared)}\n`, {mode:0o600});
  const report = await inspectCertificationRun(root, journal.runDirectory);
  assert.doesNotMatch(JSON.stringify(report), /SENTINEL|must-not-roundtrip/);
});
