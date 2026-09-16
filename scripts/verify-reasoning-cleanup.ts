/** Independently interrupt J004, then inspect PostgreSQL and OS process groups. */
import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {createHash, randomBytes} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stderrLimit = 8 * 1024;
const allowedFailureClassifications = [
  'interrupted',
  'child_process_exit',
  'pool_runtime_error',
  'journey_failure',
  'cleanup_failure',
] as const;
type RunnerFailureClassification = typeof allowedFailureClassifications[number];
const allowedFailurePhases = ['runtime', 'cleanup'] as const;
type RunnerFailurePhase = typeof allowedFailurePhases[number];
type SecondaryCondition = {
  classification: RunnerFailureClassification;
  phase: RunnerFailurePhase;
};
const allowedCleanupErrors = new Set([
  'child_stop_failed',
  'process_group_cleanup_failed',
  'pool_close_failed',
  'pool_disconnect_failed',
  'database_still_present',
  'database_drop_graceful_failed',
  'database_drop_force_failed',
  'database_verify_failed',
  'admin_close_failed',
  'temporary_directory_cleanup_failed',
  'process_group_still_present',
  'manifest_write_failed',
]);
type Manifest = {
  journey: string; runnerPid: number; ready: boolean; cleanedUp?: boolean;
  apiBase: string; fixtureBase: string;
  database: {host: string; port: string | number; name: string};
  processes: Array<{role: string; pid: number; pgid: number; readyAt: string}>;
  diagnostic?: {
    classification: unknown;
    phase: unknown;
    secondaryConditions: unknown;
    cleanupErrors: unknown;
    poolError?: unknown;
  };
  cleanupStage?: unknown;
};
const allowedCleanupStages = new Set([
  'children', 'pool', 'pool_disconnect', 'database', 'admin', 'temporary_directory', 'complete',
]);
const stderrSignatures = [
  ['node_unhandled_error_event', /Unhandled 'error' event/],
  ['node_unhandled_rejection', /UnhandledPromiseRejection|unhandledRejection/],
  ['postgres_connection_terminated', /Connection terminated unexpectedly|terminating connection due to administrator command/],
  ['ipc_channel_closed', /ERR_IPC_CHANNEL_CLOSED|channel closed/],
  ['broken_pipe', /\bEPIPE\b|write EPIPE/],
] as const;
type CaseSpec = {
  name: string;
  trigger:
    | {kind: 'signals'; signals: NodeJS.Signals[]; intervalMs: number}
    | {kind: 'child_failure'; role: 'worker-ready'; signal: 'SIGKILL'}
    | {kind: 'pool_failure'; applicationName: 'knowscroll-j004-runner'};
  expectedClassification: RunnerFailureClassification;
  runnerArgs?: string[];
  expectedSecondaryConditions?: SecondaryCondition[];
};
const cases: CaseSpec[] = [
  {name: 'single_sigterm', trigger: {kind: 'signals', signals: ['SIGTERM'], intervalMs: 0}, expectedClassification: 'interrupted'},
  {name: 'single_sigint', trigger: {kind: 'signals', signals: ['SIGINT'], intervalMs: 0}, expectedClassification: 'interrupted'},
  {name: 'pool_then_signal', trigger: {kind: 'signals', signals: ['SIGINT'], intervalMs: 0},
    expectedClassification: 'pool_runtime_error', runnerArgs: ['--inject-pool-error-before-interrupt'],
    expectedSecondaryConditions: [{classification: 'interrupted', phase: 'runtime'}]},
  {name: 'signal_then_pool_cleanup', trigger: {kind: 'signals', signals: ['SIGINT'], intervalMs: 0},
    expectedClassification: 'interrupted', runnerArgs: ['--inject-pool-error-after-interrupt'],
    expectedSecondaryConditions: [{classification: 'pool_runtime_error', phase: 'cleanup'}]},
  {name: 'repeated_sigterm', trigger: {kind: 'signals', signals: ['SIGTERM', 'SIGTERM'], intervalMs: 25}, expectedClassification: 'interrupted'},
  {name: 'mixed_repeated_signals', trigger: {kind: 'signals', signals: ['SIGTERM', 'SIGINT'], intervalMs: 25}, expectedClassification: 'interrupted'},
  {name: 'child_failure', trigger: {kind: 'child_failure', role: 'worker-ready', signal: 'SIGKILL'}, expectedClassification: 'child_process_exit'},
  {name: 'pool_runtime_failure', trigger: {kind: 'pool_failure', applicationName: 'knowscroll-j004-runner'}, expectedClassification: 'pool_runtime_error'},
];

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}
async function configDatabase() {
  let config: Record<string, string> = {};
  try {
    config = Object.fromEntries((await readFile(resolve(root, '.env'), 'utf8')).split('\n').flatMap(line => {
      const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
      return match ? [[match[1]!, match[2]!]] : [];
    }));
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const source = process.env.DATABASE_URL ?? config.DATABASE_URL;
  assert.ok(source, 'loopback database configuration required');
  const url = new URL(source);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'loopback database required');
  return url;
}
function sanitizedDiagnostic(manifest: Manifest | undefined, exit: {code: number | null; signal: NodeJS.Signals | null} | undefined) {
  const raw = manifest?.diagnostic;
  const cleanupStageValid = manifest?.cleanupStage === undefined
    || (typeof manifest.cleanupStage === 'string' && allowedCleanupStages.has(manifest.cleanupStage));
  const phaseValid = typeof raw?.phase === 'string'
    && (allowedFailurePhases as readonly string[]).includes(raw.phase);
  const secondaryConditionsValid = Array.isArray(raw?.secondaryConditions)
    && raw.secondaryConditions.length < allowedFailureClassifications.length
    && raw.secondaryConditions.every(condition => {
      if (!condition || typeof condition !== 'object' || Array.isArray(condition)) return false;
      const value = condition as Record<string, unknown>;
      return Object.keys(value).length === 2
        && typeof value.classification === 'string'
        && (allowedFailureClassifications as readonly string[]).includes(value.classification)
        && value.classification !== raw?.classification
        && typeof value.phase === 'string'
        && (allowedFailurePhases as readonly string[]).includes(value.phase);
    })
    && new Set(raw.secondaryConditions.map(condition =>
      (condition as Record<string, unknown>).classification)).size === raw.secondaryConditions.length;
  const classificationValid = typeof raw?.classification === 'string'
    && (allowedFailureClassifications as readonly string[]).includes(raw.classification)
    && phaseValid && secondaryConditionsValid && cleanupStageValid;
  const cleanupErrorsValid = Array.isArray(raw?.cleanupErrors)
    && raw.cleanupErrors.length <= allowedCleanupErrors.size
    && raw.cleanupErrors.every(value => typeof value === 'string' && allowedCleanupErrors.has(value));
  const hasPoolCondition = raw?.classification === 'pool_runtime_error'
    || (Array.isArray(raw?.secondaryConditions) && raw.secondaryConditions.some(condition =>
      condition && typeof condition === 'object' && !Array.isArray(condition)
      && (condition as Record<string, unknown>).classification === 'pool_runtime_error'));
  const poolError = raw?.poolError;
  const poolErrorValid = !hasPoolCondition
    ? poolError === undefined
    : Boolean(poolError && typeof poolError === 'object' && !Array.isArray(poolError)
      && Object.keys(poolError).length === 4
      && ((poolError as Record<string, unknown>).origin === 'db_pool'
        || (poolError as Record<string, unknown>).origin === 'admin_client')
      && (poolError as Record<string, unknown>).phase !== undefined
      && (allowedFailurePhases as readonly unknown[]).includes((poolError as Record<string, unknown>).phase)
      && typeof (poolError as Record<string, unknown>).cleanupStage === 'string'
      && ((poolError as Record<string, unknown>).cleanupStage === 'not_started'
        || allowedCleanupStages.has((poolError as Record<string, unknown>).cleanupStage as string))
      && ((poolError as Record<string, unknown>).sqlState === '57P01'
        || (poolError as Record<string, unknown>).sqlState === 'unknown'));
  const classification = classificationValid && cleanupErrorsValid && poolErrorValid
    ? raw!.classification as RunnerFailureClassification
    : raw !== undefined
      ? 'invalid_runner_diagnostic'
      : exit?.signal
        ? 'abrupt_signal_exit'
        : 'missing_runner_diagnostic';
  const cleanupErrors = cleanupErrorsValid
    ? raw.cleanupErrors as string[]
    : [];
  const phase = classificationValid ? raw!.phase as RunnerFailurePhase : 'unavailable';
  const secondaryConditions = classificationValid
    ? raw!.secondaryConditions as SecondaryCondition[]
    : [];
  const cleanupStage = typeof manifest?.cleanupStage === 'string'
    && allowedCleanupStages.has(manifest.cleanupStage) ? manifest.cleanupStage
      : manifest?.cleanupStage === undefined ? 'unavailable' : 'invalid';
  return {classification, phase, secondaryConditions, cleanupErrors, cleanupStage,
    poolError: poolErrorValid ? poolError ?? null : 'invalid'};
}
function validManifestIdentity(manifest: Manifest | undefined, runnerPid: number | undefined, database: URL) {
  return Boolean(manifest && typeof manifest.database?.name === 'string' && Array.isArray(manifest.processes)
    && manifest.journey === 'J004' && manifest.runnerPid === runnerPid
    && /^knowscroll_j004_[a-f0-9]+$/.test(manifest.database.name)
    && manifest.database.host === database.hostname
    && String(manifest.database.port) === (database.port || '5432')
    && manifest.processes.every(process => Number.isInteger(process.pid) && process.pid > 1
      && process.pgid === process.pid && process.pid !== runnerPid));
}

const database = await configDatabase();
const adminUrl = new URL(database); adminUrl.pathname = '/postgres';
const admin = new pg.Client({connectionString: adminUrl.toString()});
await admin.connect();
const observations: unknown[] = [];
const suffix = randomBytes(8).toString('hex');
const evidencePath = resolve(root, `artifacts/j004-cleanup-${suffix}.json`);
const source = {
  revision: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(),
  dirty: execFileSync('git', ['status', '--porcelain'], {cwd: root, encoding: 'utf8'}).trim() !== '',
  files: await Promise.all([
    'scripts/run-isolated-reasoning-journey.ts',
    'scripts/verify-reasoning-cleanup.ts',
  ].map(async path => ({path, sha256: createHash('sha256').update(await readFile(resolve(root, path))).digest('hex')}))),
  platform: process.platform,
  arch: process.arch,
};
await mkdir(resolve(root, 'artifacts'), {recursive: true});
try {
  for (const spec of cases) {
    const manifestPath = resolve(root, `artifacts/j004-interrupt-${suffix}-${spec.name}.json`);
    const receiptPath = resolve(root, `artifacts/j004-interrupt-${suffix}-${spec.name}-receipt.json`);
    const env: NodeJS.ProcessEnv = Object.fromEntries(
      ['PATH', 'HOME', 'LANG', 'LC_ALL', 'KS_DEV_ROOT', 'TMPDIR'].flatMap(key =>
        process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
    env.DATABASE_URL = database.toString();
    env.NODE_ENV = 'test';
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/run-isolated-reasoning-journey.ts',
      '--manifest', manifestPath, '--receipt', receiptPath, '--pause-for-interrupt', ...(spec.runnerArgs ?? [])],
    {cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'], detached: true});
    let exit: {code: number | null; signal: NodeJS.Signals | null} | undefined;
    let spawnFailed = false;
    let stderrBytes = 0;
    let stderrOverlap = '';
    const stderrClassifications = new Set<string>();
    child.once('error', () => { spawnFailed = true; });
    child.once('exit', (code, signal) => { exit = {code, signal}; });
    child.stderr?.on('data', chunk => {
      stderrBytes += Buffer.byteLength(chunk);
      const scan = stderrOverlap + String(chunk);
      for (const [classification, pattern] of stderrSignatures)
        if (pattern.test(scan)) stderrClassifications.add(classification);
      stderrOverlap = scan.slice(-256);
    });
    let manifest: Manifest | undefined;
    let validated: Manifest | undefined;
    let final: Manifest | undefined;
    let stage = 'readiness';
    let primaryFailure: Error | undefined;
    const fallbackErrors: string[] = [];
    const attemptCleanup = async (classification: string, fn: () => Promise<void>) => {
      try { await fn(); } catch { fallbackErrors.push(classification); }
    };
    try {
      for (let i = 0; i < 600; i++) {
        if (spawnFailed || exit) break;
        try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw Error('manifest_read_failed'); }
        if (manifest?.ready) break;
        await delay(100);
      }
      assert.equal(spawnFailed, false, 'runner spawn failed');
      assert.equal(exit, undefined, 'runner exited before the interruption barrier');
      assert.ok(manifest?.ready, 'runner never reached the interruption barrier');
      assert.equal(validManifestIdentity(manifest, child.pid, database), true, 'manifest identity invalid');
      assert.ok(manifest.processes.length >= 3, 'API, fixture and worker processes required');
      assert.equal(new Set(manifest.processes.map(process => process.pid)).size, manifest.processes.length);
      assert.equal(new Set(manifest.processes.map(process => process.role)).size, manifest.processes.length);
      assert.ok(manifest.processes.some(process => process.role === 'api'));
      assert.ok(manifest.processes.some(process => process.role === 'fixture'));
      assert.ok(manifest.processes.some(process => process.role.startsWith('worker')));
      for (const process of manifest.processes) {
        assert.ok(Number.isFinite(Date.parse(process.readyAt)), 'child readiness observation required');
        assert.ok(alive(process.pid), `${process.role} must exist before interruption`);
      }
      assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [manifest.database.name])).rowCount, 1,
        'database must exist before interruption');
      validated = structuredClone(manifest);
      for (const base of [manifest.apiBase, manifest.fixtureBase]) {
        const url = new URL(base);
        assert.equal(url.hostname, '127.0.0.1');
        assert.equal(url.protocol, 'http:');
        const health = await fetch(new URL('/health', url), {signal: AbortSignal.timeout(3000), redirect: 'error'});
        assert.equal(health.ok, true, 'independent readiness probe failed');
      }

      stage = 'trigger';
      const trigger = spec.trigger;
      if (trigger.kind === 'signals') {
        for (const [index, signal] of trigger.signals.entries()) {
          if (index > 0) await delay(trigger.intervalMs);
          assert.equal(child.kill(signal), true, `failed to deliver signal ${index + 1}`);
        }
      } else if (trigger.kind === 'child_failure') {
        const target = manifest.processes.find(process => process.role === trigger.role);
        assert.ok(target, 'child-failure target absent');
        process.kill(-target.pgid, trigger.signal);
      } else {
        const terminated = await admin.query<{terminated: boolean}>(
          `SELECT pg_terminate_backend(pid) AS terminated
             FROM pg_stat_activity
            WHERE datname=$1 AND application_name=$2 AND pid<>pg_backend_pid()`,
          [manifest.database.name, trigger.applicationName]);
        assert.ok(terminated.rowCount && terminated.rowCount > 0, 'runner pool backend absent');
        assert.equal(terminated.rows.every(row => row.terminated), true, 'runner pool backend termination failed');
      }

      stage = 'exit';
      for (let i = 0; i < 300 && !exit; i++) await delay(100);
      const observedExit = exit as {code: number | null; signal: NodeJS.Signals | null} | undefined;
      try { final = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest; } catch {}
      for (let i = 0; i < 50 && manifest.processes.some(process => alive(process.pid) || alive(-process.pgid)); i++)
        await delay(100);
      const processGroupsAbsent = manifest.processes.every(process => !alive(process.pid) && !alive(-process.pgid));
      const runnerAbsent = child.pid ? !alive(child.pid) : false;
      const databaseAbsent = (await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [manifest.database.name])).rowCount === 0;
      const diagnostic = sanitizedDiagnostic(final, observedExit);
      const runnerAck = final?.cleanedUp === true && final.cleanupStage === 'complete';
      const observation = {
        case: spec.name,
        trigger: spec.trigger,
        orderingProbe: spec.runnerArgs?.[0] ?? null,
        runnerPid: child.pid,
        database: manifest.database,
        processes: manifest.processes,
        exit: observedExit ?? {code: null, signal: null},
        diagnostic: {
          ...diagnostic,
          stderr: {observedBytes: Math.min(stderrBytes, stderrLimit), truncated: stderrBytes > stderrLimit,
            classifications: [...stderrClassifications]},
        },
        runnerAck,
        databaseAbsent,
        processGroupsAbsent,
        runnerAbsent,
        observedAt: new Date().toISOString(),
      };
      observations.push(observation);
      const failures: string[] = [];
      if (!observedExit) failures.push('runner_exit_missing');
      if (observedExit?.code === 0) failures.push('runner_exit_success');
      if (!validManifestIdentity(final, child.pid, database)) failures.push('final_manifest_identity_invalid');
      if (!runnerAck) failures.push('cleanup_ack_missing');
      if (diagnostic.classification !== spec.expectedClassification) failures.push('failure_classification_mismatch');
      if (diagnostic.phase !== 'runtime') failures.push('failure_phase_mismatch');
      if (spec.expectedSecondaryConditions
        && JSON.stringify(diagnostic.secondaryConditions) !== JSON.stringify(spec.expectedSecondaryConditions))
        failures.push('secondary_condition_mismatch');
      if (diagnostic.cleanupErrors.length > 0) failures.push('runner_cleanup_error');
      if (!processGroupsAbsent) failures.push('process_group_present');
      if (!databaseAbsent) failures.push('database_present');
      if (!runnerAbsent) failures.push('runner_present');
      if (failures.length) {
        primaryFailure = Error(JSON.stringify({case: spec.name, stage, failures, exit: observation.exit,
          diagnostic: observation.diagnostic, runnerAck, databaseAbsent, processGroupsAbsent, runnerAbsent}));
      }
    } catch {
      primaryFailure = Error(JSON.stringify({case: spec.name, stage, failures: ['checker_exception'],
        exit: exit ?? {code: null, signal: null}, diagnostic: sanitizedDiagnostic(final ?? manifest, exit),
        stderr: {observedBytes: Math.min(stderrBytes, stderrLimit), truncated: stderrBytes > stderrLimit,
          classifications: [...stderrClassifications]}}));
    } finally {
      await attemptCleanup('fallback_runner_stop_failed', async () => {
        if (!exit && child.pid) {
          child.kill('SIGTERM');
          for (let i = 0; i < 100 && !exit; i++) await delay(100);
          if (!exit) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
        }
      });
      if (!validated && validManifestIdentity(manifest, child.pid, database)) validated = manifest;
      // Scoped fallback prevents a failed check leaking its own resources. It
      // never changes the failed observation into passing cleanup evidence.
      if (validated) {
        for (const process of validated.processes) {
          await attemptCleanup('fallback_group_term_failed', async () => {
            try { globalThis.process.kill(-process.pgid, 'SIGTERM'); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
          });
        }
        await attemptCleanup('fallback_group_wait_failed', async () => {
          for (let i = 0; i < 50 && validated!.processes.some(process => alive(-process.pgid)); i++) await delay(100);
        });
        for (const process of validated.processes) {
          await attemptCleanup('fallback_group_kill_failed', async () => {
            try { globalThis.process.kill(-process.pgid, 'SIGKILL'); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
          });
        }
        await attemptCleanup('fallback_database_drop_failed', async () => {
          await admin.query(`DROP DATABASE IF EXISTS "${validated!.database.name}" WITH (FORCE)`);
          assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [validated!.database.name])).rowCount, 0);
        });
      }
    }
    if (primaryFailure !== undefined || fallbackErrors.length) {
      await writeFile(evidencePath, JSON.stringify({journey: 'J004', result: 'failed', source, observations,
        fallbackErrors}, null, 2) + '\n');
      console.error(JSON.stringify({journey: 'J004', check: 'interrupted-cleanup', result: 'failed',
        receiptPath: evidencePath, diagnostic: primaryFailure?.message, fallbackErrors}));
      throw Error('J004 interruption verification failed; fallback cleanup does not constitute passing evidence');
    }
  }
  await writeFile(evidencePath, JSON.stringify({journey: 'J004', result: 'passed', source, observations}, null, 2) + '\n');
  console.log(JSON.stringify({journey: 'J004', check: 'interrupted-cleanup', result: 'passed', receiptPath: evidencePath}));
} finally { await admin.end(); }
