/**
 * #201 — the server tool's decisions, without touching a server: which deploys are allowed,
 * which releases cleanup may delete, what the disk guard does at each level, and how a world's
 * env file is read. The side effects that act on these decisions live in ops/vps/tool/system.ts.
 *
 * #228 — v2 releases: which generation a release is, what a v2 release.json and files.sha256 must
 * say, how a world switches between v1 and v2 (and back on a failed deploy), and that cleanup
 * keeps every release a world uses whatever its generation. After the #228 review: links in
 * files.sha256 and their physical containment, the tar listing, the current/previous links of a
 * failed deploy or rollback, the deploy lock, cleanup steps, the migrate session and dump names.
 * (Reading real folders, archives and /proc/locks is in tree.test.ts.)
 *
 *   node --test ops/vps/tool/plan.test.ts
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  activationPlan,
  activateAfterSchemaCheck,
  afterFailedDeploy,
  checkFileList,
  checksumFor,
  checkTarEntries,
  commitOfTarget,
  cutroomSwitchDecision,
  deployLockHeldByParent,
  diskGuardDecision,
  type FsView,
  generationSwitchDecision,
  healthMatches,
  isSafeFilePath,
  linkStaysInside,
  linksAfterDeploy,
  linksAfterRollback,
  lockNeeded,
  MAX_SCHEMA_MIGRATIONS,
  parseEnvFile,
  parseSha256List,
  predeployDumpName,
  prepareV2Deployment,
  releaseGeneration,
  recoverFailedActivation,
  releasesInUse,
  releasesToDelete,
  runSteps,
  symlinkHash,
  tarEntries,
  validateDeployRequest,
  validateRunRequest,
  validateV2Manifest,
  v2SchemaCompatibility,
  withSessionOptions,
} from './plan.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

const SCHEMA = [
  { name: '0001_identity', sha256: '1'.repeat(64) },
  { name: '0002_receipts', sha256: '2'.repeat(64) },
];
const schemaSnapshot = (rows = SCHEMA) => ({
  migrations: rows.map((row) => row.name),
  checksums: rows.map((row) => ({ ...row })),
});

test('#250 activation requires the complete target registry and verified SQL checksums', () => {
  assert.equal(v2SchemaCompatibility(SCHEMA, schemaSnapshot()).ok, true);
  const newer = [...SCHEMA, { name: '0003_personal', sha256: '3'.repeat(64) }];
  for (const observed of [
    null, undefined, {}, { migrations: SCHEMA.map((r) => r.name) },
    schemaSnapshot(newer), schemaSnapshot(SCHEMA.slice(0, 1)),
    schemaSnapshot([...SCHEMA].reverse()), schemaSnapshot([SCHEMA[0]!, SCHEMA[0]!]),
    { ...schemaSnapshot(), migrations: ['0001_identity', '0002_other'] },
    { ...schemaSnapshot(), checksums: [SCHEMA[0]] },
    { ...schemaSnapshot(), checksums: [...SCHEMA, newer[2]] },
    { ...schemaSnapshot(), checksums: [...SCHEMA].reverse() },
    { ...schemaSnapshot(), checksums: [SCHEMA[0], { ...SCHEMA[1], sha256: 'f'.repeat(64) }] },
    { ...schemaSnapshot(), migrations: ['0001_identity', 'bad\nname'] },
  ]) assert.equal(v2SchemaCompatibility(SCHEMA, observed).ok, false);
  assert.equal(v2SchemaCompatibility([...SCHEMA].reverse(), schemaSnapshot()).ok, false);
  assert.equal(v2SchemaCompatibility([SCHEMA[0]!, SCHEMA[0]!], schemaSnapshot()).ok, false);
  assert.equal(v2SchemaCompatibility(SCHEMA, schemaSnapshot(Array.from(
    { length: MAX_SCHEMA_MIGRATIONS + 1 }, (_, i) => ({
      name: `${String(i).padStart(4, '0')}_fixture`, sha256: 'a'.repeat(64),
    }),
  ))).ok, false);
});

test('#250 v2 guard refuses before link/service mutations; equal-schema code can switch', async () => {
  const before = { current: A, previous: B };
  let links = before;
  const calls: string[] = [];
  await assert.rejects(activateAfterSchemaCheck('v2', {
    checkV2Schema: () => {
      const result = v2SchemaCompatibility(SCHEMA.slice(0, 1), schemaSnapshot());
      assert.equal(result.ok, false);
      throw new Error('fixture: database ahead');
    },
    pointCurrent: () => { links = { current: B, previous: A }; },
    start: () => { calls.push('services'); return Promise.resolve(true); },
  }), /database ahead/);
  assert.equal(links, before, 'manual refusal preserves both original links');
  assert.deepEqual(calls, [], 'manual refusal does not stop/start any service');
  const successfulCalls: string[] = [];
  assert.equal(await activateAfterSchemaCheck('v2', {
    checkV2Schema: () => { assert.equal(v2SchemaCompatibility(SCHEMA, schemaSnapshot()).ok, true); successfulCalls.push('schema'); },
    pointCurrent: () => { successfulCalls.push('links'); },
    start: () => { successfulCalls.push('services'); return Promise.resolve(true); },
  }), true);
  assert.deepEqual(successfulCalls, ['schema', 'links', 'services']);
});

test('#250 failed deploy cannot restart old v2 after new/unknown DDL', async () => {
  for (const snapshot of [schemaSnapshot(), null]) {
    const calls: string[] = [];
    const healthy = await recoverFailedActivation('v2', {
      activate: () => activateAfterSchemaCheck('v2', {
        checkV2Schema: () => {
          const result = v2SchemaCompatibility(SCHEMA.slice(0, 1), snapshot);
          if (!result.ok) throw new Error(result.reason);
        },
        pointCurrent: () => { calls.push('links'); },
        start: () => { calls.push('old-v2-start'); return Promise.resolve(true); },
      }),
      stopV2: () => { calls.push('stop-unsafe-v2'); },
      restoreLinks: () => { calls.push('original-links'); },
    });
    assert.equal(healthy, false);
    assert.deepEqual(calls, ['stop-unsafe-v2', 'original-links']);
  }
  const calls: string[] = [];
  assert.equal(await recoverFailedActivation('v2', {
    activate: () => Promise.resolve(false),
    stopV2: () => { calls.push('stop-unhealthy-v2'); },
    restoreLinks: () => {},
  }), false);
  assert.deepEqual(calls, ['stop-unhealthy-v2']);
  assert.equal(await recoverFailedActivation('v2', {
    activate: () => Promise.resolve(true),
    stopV2: () => { throw new Error('must not stop a healthy compatible recovery'); },
    restoreLinks: () => {},
  }), true);
  const unsafeCalls: string[] = [];
  await assert.rejects(recoverFailedActivation('v2', {
    activate: () => Promise.resolve(false),
    stopV2: () => { throw new Error('fixture: stop failed'); },
    restoreLinks: () => { unsafeCalls.push('exposed-old-links'); },
  }), /stop failed/);
  assert.deepEqual(unsafeCalls, [], 'never expose old code to automatic restart if stop failed');
});

test('#250 failed preparation never activates prior v2 even when its schema snapshot would match', async () => {
  const calls: string[] = [];
  const recovered = await recoverFailedActivation('v2', {
    activate: () => activateAfterSchemaCheck('v2', {
      checkV2Schema: () => { assert.equal(v2SchemaCompatibility(SCHEMA, schemaSnapshot()).ok, true); calls.push('schema'); },
      pointCurrent: () => { calls.push('old-links'); },
      start: () => { calls.push('old-v2-start'); return Promise.resolve(true); },
    }),
    stopV2: () => { calls.push('stop-disable-v2'); },
    restoreLinks: () => { calls.push('original-links'); },
  }, { preparationFailed: true });
  assert.equal(recovered, false, 'matching metadata cannot prove an uncertain COMMIT finished');
  assert.deepEqual(calls, ['stop-disable-v2', 'original-links']);
});

test('#250 failed preparation cannot restore old links when stopping v2 fails', async () => {
  const calls: string[] = [];
  await assert.rejects(recoverFailedActivation('v2', {
    activate: () => { calls.push('activation'); return Promise.resolve(true); },
    stopV2: () => { calls.push('stop-failed'); throw new Error('fixture: stop failed'); },
    restoreLinks: () => { calls.push('unsafe-old-links'); },
  }, { preparationFailed: true }), /stop failed/);
  assert.deepEqual(calls, ['stop-failed']);
});

test('#250 acknowledged preparation retains compatible v2 recovery', async () => {
  const calls: string[] = [];
  assert.equal(await recoverFailedActivation('v2', {
    activate: () => activateAfterSchemaCheck('v2', {
      checkV2Schema: () => { assert.equal(v2SchemaCompatibility(SCHEMA, schemaSnapshot()).ok, true); calls.push('schema'); },
      pointCurrent: () => { calls.push('links'); },
      start: () => { calls.push('start'); return Promise.resolve(true); },
    }),
    stopV2: () => { calls.push('unexpected-stop'); },
    restoreLinks: () => { calls.push('unexpected-restore'); },
  }, { preparationFailed: false }), true);
  assert.deepEqual(calls, ['schema', 'links', 'start']);
});

test('#250 failed v2 preparation preserves prior v1 separate-database recovery', async () => {
  const calls: string[] = [];
  assert.equal(await recoverFailedActivation('v1', {
    activate: () => activateAfterSchemaCheck('v1', {
      checkV2Schema: () => { throw new Error('legacy must not read v2'); },
      pointCurrent: () => { calls.push('legacy-links'); },
      start: () => { calls.push('legacy-start'); return Promise.resolve(true); },
    }),
    stopV2: () => { throw new Error('legacy recovery does not use the v2 failure branch'); },
    restoreLinks: () => { calls.push('unexpected-restore'); },
  }, { preparationFailed: true }), true);
  assert.deepEqual(calls, ['legacy-links', 'legacy-start']);
});

test('#250 v1 activation/recovery never reads the separate v2 database', async () => {
  const calls: string[] = [];
  const result = await recoverFailedActivation('v1', {
    activate: () => activateAfterSchemaCheck('v1', {
      checkV2Schema: () => { throw new Error('legacy must not read v2'); },
      pointCurrent: () => { calls.push('links'); },
      start: () => { calls.push('v1-start'); return Promise.resolve(true); },
    }),
    stopV2: () => { throw new Error('not the v2 failure branch'); },
    restoreLinks: () => {},
  });
  assert.equal(result, true);
  assert.deepEqual(calls, ['links', 'v1-start']);
});

test('#250 v2 deployment quiesces before dump/DDL and guards before links/start', async () => {
  const calls: string[] = [];
  const dump = prepareV2Deployment({
    quiesce: () => { calls.push('quiesce-v2'); },
    dump: () => { calls.push('dump'); return 'fixture.dump'; },
    migrate: () => { calls.push('migrate'); },
  });
  assert.equal(dump, 'fixture.dump');
  assert.equal(await activateAfterSchemaCheck('v2', {
    checkV2Schema: () => { calls.push('schema'); },
    pointCurrent: () => { calls.push('links'); },
    start: () => { calls.push('start'); return Promise.resolve(true); },
  }), true);
  assert.deepEqual(calls, ['quiesce-v2', 'dump', 'migrate', 'schema', 'links', 'start']);
  const blocked: string[] = [];
  assert.throws(() => prepareV2Deployment({
    quiesce: () => { blocked.push('stop-failed'); throw new Error('fixture: stop failed'); },
    dump: () => { blocked.push('dump'); },
    migrate: () => { blocked.push('DDL'); },
  }), /stop failed/);
  assert.deepEqual(blocked, ['stop-failed'], 'stop/disable refusal prevents dump, DDL and activation');
});

test('#250 failed forward DDL keeps old v2 stopped until compatible recovery exists', async () => {
  const calls: string[] = [];
  assert.throws(() => prepareV2Deployment({
    quiesce: () => { calls.push('quiesce-v2'); },
    dump: () => { calls.push('dump'); },
    migrate: () => { calls.push('DDL-failed'); throw new Error('fixture: DDL failed'); },
  }), /DDL failed/);
  assert.equal(await recoverFailedActivation('v2', {
    activate: () => activateAfterSchemaCheck('v2', {
      checkV2Schema: () => {
        const match = v2SchemaCompatibility(SCHEMA.slice(0, 1), schemaSnapshot());
        if (!match.ok) throw new Error(match.reason);
      },
      pointCurrent: () => { calls.push('unsafe-old-links'); },
      start: () => { calls.push('unsafe-old-start'); return Promise.resolve(true); },
    }),
    stopV2: () => { calls.push('keep-v2-stopped'); },
    restoreLinks: () => { calls.push('original-links-after-stop'); },
  }), false);
  assert.deepEqual(calls, ['quiesce-v2', 'dump', 'DDL-failed', 'keep-v2-stopped', 'original-links-after-stop']);
});

test('#250 the actual system branches use the tested gate and conservative recovery seam', () => {
  const source = readFileSync(new URL('./system.ts', import.meta.url), 'utf8');
  const activation = source.slice(source.indexOf('async function activate('), source.indexOf('async function restoreRunning('));
  assert.match(activation, /activateAfterSchemaCheck\(generation,/);
  assert.match(activation, /checkV2Schema: \(\) => requireMatchingV2Schema/);
  const recovery = source.slice(source.indexOf('async function restoreRunning('), source.indexOf('function cleanupAfterDeploy('));
  assert.match(recovery, /recoverFailedActivation\(next.generation,/);
  assert.match(recovery, /stopV2: \(\) => quiesceV2\(world\)/);
  assert.match(recovery, /\}, context\)/);
  const quiesce = source.slice(source.indexOf('function quiesceV2('), source.indexOf('async function activate('));
  assert.match(quiesce, /worldUnits\(world, 'v2'\)/);
  assert.match(quiesce, /systemctl\('stop', units.target, \.\.\.units.services\)/);
  assert.match(quiesce, /systemctl\('disable', units.target, \.\.\.units.services\)/);
  assert.doesNotMatch(quiesce, /worldUnits\(world, 'v1'\)/);
  const manual = source.slice(source.indexOf('export async function rollback('), source.indexOf('/** #228: every'));
  assert.ok(manual.indexOf('requireMatchingV2Schema(w, back.commit)') >= 0);
  assert.ok(manual.indexOf('requireMatchingV2Schema(w, back.commit)') < manual.indexOf('await activate('));
  assert.match(manual, /await activate\(back.generation, expect,\s*\(\) => applyLinks/);
  const deployment = source.slice(source.indexOf('export async function deploy('), source.indexOf('export async function rollback('));
  assert.match(deployment, /migrationFailed = true/);
  assert.match(deployment, /dump = prepareV2Deployment\(\{\s*quiesce: \(\) => quiesceV2\(w\),\s*dump: \(\) => predeployDump\(w, commit\),\s*migrate: \(\) => migrateV2/);
  assert.match(deployment, /!migrationFailed && await activate/);
  assert.match(deployment, /restoreRunning\(w, beforeSlot,\s*\(\) => applyLinks/);
  assert.match(deployment, /\{ preparationFailed: migrationFailed \}/);
  assert.match(deployment, /failed-recovery-incomplete/);
  assert.doesNotMatch(source, /assumed: 'v1'/, 'an unknown manifest cannot bypass the v2 guard');
});

test('a deploy names a known world and a full commit', () => {
  assert.deepEqual(validateDeployRequest('dev', A, { tip: null }), {
    ok: true,
    world: 'dev',
    commit: A,
  });
  assert.equal(validateDeployRequest('prod', A, { tip: null }).ok, false);
  assert.equal(validateDeployRequest('dev', 'abc123', { tip: null }).ok, false);
  assert.equal(
    validateDeployRequest('dev', A.toUpperCase(), { tip: null }).ok,
    false,
  );
});

test('dev accepts any commit; stage and live only their branch tip', () => {
  assert.equal(validateDeployRequest('dev', A, { tip: B }).ok, true);
  assert.equal(validateDeployRequest('stage', A, { tip: A }).ok, true);
  const stale = validateDeployRequest('stage', A, { tip: B });
  assert.equal(stale.ok, false);
  assert.match(stale.ok ? '' : stale.reason, /tip/);
  assert.equal(validateDeployRequest('live', A, { tip: null }).ok, false);
});

test('cleanup never selects a release a world uses now or used last', () => {
  const releases = [
    { commit: '1'.repeat(40), mtimeMs: 1 },
    { commit: '2'.repeat(40), mtimeMs: 2 },
    { commit: '3'.repeat(40), mtimeMs: 3 },
    { commit: '4'.repeat(40), mtimeMs: 4 },
    { commit: '5'.repeat(40), mtimeMs: 5 },
    { commit: '6'.repeat(40), mtimeMs: 6 },
  ];
  const inUse = new Set(['1'.repeat(40), '2'.repeat(40)]);
  assert.deepEqual(releasesToDelete(releases, inUse, 3), ['3'.repeat(40)]);
  // Emergency keeps fewer of the unused ones, still never an in-use one.
  assert.deepEqual(releasesToDelete(releases, inUse, 2), [
    '3'.repeat(40),
    '4'.repeat(40),
  ]);
  assert.deepEqual(releasesToDelete(releases, inUse, 0).sort(), [
    '3'.repeat(40),
    '4'.repeat(40),
    '5'.repeat(40),
    '6'.repeat(40),
  ]);
});

test('disk guard: warn at 80 %, act at 90 %, recover only below 85 % (hysteresis)', () => {
  assert.equal(diskGuardDecision(50, false), 'fine');
  assert.equal(diskGuardDecision(80, false), 'warn');
  assert.equal(diskGuardDecision(89.9, false), 'warn');
  assert.equal(diskGuardDecision(90, false), 'critical');
  assert.equal(diskGuardDecision(95, true), 'still-critical');
  assert.equal(diskGuardDecision(86, true), 'still-critical');
  assert.equal(diskGuardDecision(84.9, true), 'recovered');
});

test('env files: KEY=VALUE lines, values may contain =, comments and blanks ignored', () => {
  assert.deepEqual(
    parseEnvFile(
      '# comment\n\nPORT=4330\nDATABASE_URL=postgresql://u:p@h/db?x=1\n bad line\n',
    ),
    { PORT: '4330', DATABASE_URL: 'postgresql://u:p@h/db?x=1' },
  );
});

test('#199 ks run starts only the operator programs, for a known world', () => {
  assert.deepEqual(validateRunRequest('stage', 'generation-cli'), {
    ok: true,
    world: 'stage',
    program: 'generation-cli',
  });
  assert.equal(validateRunRequest('dev', 'publication').ok, true);
  assert.equal(validateRunRequest('stage', 'install-supply').ok, true);
  assert.equal(validateRunRequest('dev', 'migrate').ok, false);
  assert.equal(validateRunRequest('dev', '../../bin/sh').ok, false);
  assert.equal(validateRunRequest('prod', 'publication').ok, false);
});

test('#199 the shared Cutroom never switches or restarts while a paid order is open', () => {
  assert.equal(cutroomSwitchDecision(0).ok, true);
  assert.equal(cutroomSwitchDecision(1).ok, false);
  assert.match(cutroomSwitchDecision(2).reason, /2 paid order/);
  assert.equal(cutroomSwitchDecision(null).ok, false, 'unknown is refused');
});

// ------------------------------------------------------------------------------------------------
// #228: v2 releases
// ------------------------------------------------------------------------------------------------

const RELEASES = '/srv/knowscroll/releases';
const V1 = '1'.repeat(40);
const V2 = '2'.repeat(40);
const V2_OLD = '3'.repeat(40);

function v2Manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 'ks-release.v2',
    commit: V2,
    builtAt: '2026-10-19T12:00:00.000Z',
    node: 'v22.23.0',
    programs: {
      api: { cwd: 'api', exec: ['node', '--enable-source-maps', 'dist/main.js'] },
      worker: {
        cwd: 'worker',
        exec: ['node', '--enable-source-maps', 'dist/main.js'],
      },
    },
    migrate: { cwd: 'api', exec: ['node', 'dist/migrate.js'] },
    web: 'web',
    migrations: ['0001_identity', '0002_content'],
    ...overrides,
  };
}

function hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** A small release: its files' hashes and the files.sha256 that lists them. */
function release(): { actual: Map<string, string>; listing: string } {
  const files: Record<string, string> = {
    'release.json': JSON.stringify(v2Manifest()),
    'api/package.json': '{}',
    'api/dist/main.js': 'api',
    'api/dist/migrate.js': 'migrate',
    'api/node_modules/pg/index.js': 'pg',
    'worker/dist/main.js': 'worker',
    'web/index.html': '<!doctype html>',
  };
  const actual = new Map(
    Object.entries(files).map(([path, text]) => [path, hex(text)]),
  );
  const listing = [...actual]
    .map(([path, hash]) => `${hash}  ${path}`)
    .join('\n');
  return { actual, listing: `${listing}\n` };
}

test('#228 a release.json without a schema is v1; ks-release.v2 is v2; anything else is refused', () => {
  assert.deepEqual(
    releaseGeneration({ commit: V1, bundles: { 'dist/api.mjs': 'x' } }),
    { ok: true, value: 'v1' },
  );
  assert.deepEqual(releaseGeneration(v2Manifest()), { ok: true, value: 'v2' });
  assert.equal(releaseGeneration({ schema: 'ks-release.v3' }).ok, false);
  assert.equal(releaseGeneration([]).ok, false);
  assert.equal(releaseGeneration(null).ok, false);
});

test('#228 a v2 release.json names its commit, both programs, a migrate command and web/', () => {
  const ok = validateV2Manifest(v2Manifest(), V2);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.ok ? ok.value.programs.api.exec : null, [
    'node',
    '--enable-source-maps',
    'dist/main.js',
  ]);
  const refused = (manifest: unknown, commit = V2): string => {
    const result = validateV2Manifest(manifest, commit);
    assert.equal(result.ok, false);
    return result.ok ? '' : result.reason;
  };
  assert.match(refused(v2Manifest(), V2_OLD), /is for/);
  assert.match(refused(v2Manifest({ schema: undefined })), /not a ks-release.v2/);
  assert.match(
    refused(
      v2Manifest({
        programs: { api: { cwd: 'api', exec: ['node', 'dist/main.js'] } },
      }),
    ),
    /exactly the programs api, worker/,
  );
  assert.match(
    refused(
      v2Manifest({
        programs: {
          api: { cwd: 'api', exec: ['node', 'dist/main.js'] },
          worker: { cwd: 'worker', exec: ['node', 'dist/main.js'] },
          cron: { cwd: 'cron', exec: ['node', 'dist/main.js'] },
        },
      }),
    ),
    /exactly the programs/,
  );
  assert.match(
    refused(v2Manifest({ migrate: { cwd: 'api', exec: ['sh', '-c', 'x'] } })),
    /migrate.exec/,
  );
  assert.match(
    refused(v2Manifest({ migrate: { cwd: '../etc', exec: ['node', 'x.js'] } })),
    /migrate.cwd/,
  );
  assert.match(
    refused(v2Manifest({ migrate: { cwd: '/srv', exec: ['node', 'x.js'] } })),
    /migrate.cwd/,
  );
  assert.match(
    refused(v2Manifest({ migrate: { cwd: 'api', exec: ['node', 'a\nb'] } })),
    /single-line/,
  );
  assert.match(refused(v2Manifest({ web: 'client' })), /web must be "web"/);
  assert.match(refused(v2Manifest({ migrations: [1] })), /migrations/);
  assert.match(refused(v2Manifest({ builtAt: 'yesterday' })), /builtAt/);
});

test('#228 files.sha256 must describe the release exactly', () => {
  const { actual, listing } = release();
  assert.deepEqual(checkFileList(listing, actual), {
    ok: true,
    value: actual.size,
  });
  // sha256sum's binary-mode marker is accepted too.
  assert.equal(checkFileList(listing.replaceAll('  ', ' *'), actual).ok, true);
});

test('#228 a manifest hash mismatch is refused', () => {
  const { actual, listing } = release();
  const tampered = new Map(actual).set('api/dist/main.js', hex('something else'));
  const result = checkFileList(listing, tampered);
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.reason, /hash mismatch api\/dist\/main\.js/);
});

test('#228 files.sha256 refuses missing, unlisted, duplicate and unsafe entries', () => {
  const { actual, listing } = release();
  const missing = new Map(actual);
  missing.delete('web/index.html');
  assert.match(
    (() => {
      const r = checkFileList(listing, missing);
      return r.ok ? '' : r.reason;
    })(),
    /missing web\/index\.html/,
  );
  const extra = new Map(actual).set('api/dist/extra.js', hex('extra'));
  assert.match(
    (() => {
      const r = checkFileList(listing, extra);
      return r.ok ? '' : r.reason;
    })(),
    /not listed api\/dist\/extra\.js/,
  );
  const line = `${hex('x')}  api/dist/main.js\n`;
  assert.equal(parseSha256List(line + line).ok, false, 'duplicate path');
  assert.equal(parseSha256List(`${hex('x')}  ../etc/passwd\n`).ok, false);
  assert.equal(parseSha256List(`${hex('x')}  /etc/passwd\n`).ok, false);
  assert.equal(parseSha256List(`\\${hex('x')}  a\\nb\n`).ok, false, 'escaped name');
  assert.equal(parseSha256List(`${hex('x')} api/dist/main.js\n`).ok, false, 'one space');
  assert.equal(parseSha256List('').ok, false, 'empty list');
  assert.equal(isSafeFilePath('node_modules/@scope/pkg/file name.js'), true);
  assert.equal(isSafeFilePath('a/./b'), false);
  assert.equal(isSafeFilePath('a//b'), false);
});

test('#228 a world switches v1 → v2: v1 stops and is disabled, v2 starts', () => {
  assert.deepEqual(activationPlan('dev', 'v2'), {
    stop: {
      target: 'ks-world@dev.target',
      services: [
        'ks-api@dev.service',
        'ks-worker@dev.service',
        'ks-maintenance@dev.service',
        'ks-generation@dev.service',
      ],
    },
    start: 'ks2-world@dev.target',
  });
});

test('#228 a world switches v2 → v1: v2 stops and is disabled, v1 starts', () => {
  assert.deepEqual(activationPlan('stage', 'v1'), {
    stop: {
      target: 'ks2-world@stage.target',
      services: ['ks2-api@stage.service', 'ks2-worker@stage.service'],
    },
    start: 'ks-world@stage.target',
  });
});

test('#228 a failed v2 deploy rolls back to the v1 release that ran before, and restarts v1', () => {
  const next = afterFailedDeploy('dev', { commit: V1, generation: 'v1' });
  assert.equal(next.action, 'restore');
  if (next.action !== 'restore') return;
  assert.equal(next.commit, V1);
  assert.equal(next.generation, 'v1');
  assert.equal(next.plan.start, 'ks-world@dev.target');
  assert.equal(next.plan.stop.target, 'ks2-world@dev.target');
});

test('#228 a failed v2 deploy after a v2 release restores that v2 release', () => {
  const next = afterFailedDeploy('stage', { commit: V2_OLD, generation: 'v2' });
  assert.equal(next.action, 'restore');
  if (next.action !== 'restore') return;
  assert.equal(next.generation, 'v2');
  assert.equal(next.plan.start, 'ks2-world@stage.target');
  assert.equal(next.plan.stop.target, 'ks-world@stage.target');
});

test("#228 a failed first deploy (placeholder before it) stops both generations", () => {
  assert.deepEqual(afterFailedDeploy('dev', null), {
    action: 'stop',
    targets: ['ks-world@dev.target', 'ks2-world@dev.target'],
  });
});

test('#228 cleanup keeps every release a world uses, v1 or v2, in any world folder', () => {
  const links = [
    { path: '/srv/knowscroll/dev/current', target: `${RELEASES}/${V2}` },
    { path: '/srv/knowscroll/dev/previous', target: `${RELEASES}/${V1}` },
    // A relative link and a trailing slash name the same releases.
    { path: '/srv/knowscroll/stage/current', target: `../releases/${V2_OLD}/` },
    { path: '/srv/knowscroll/stage/previous', target: null },
    // A world this tool has no name for still protects what it uses.
    { path: '/srv/knowscroll/v9/current', target: `${RELEASES}/${'9'.repeat(40)}` },
    // Not releases: the placeholder and Cutroom's own release folder.
    { path: '/srv/knowscroll/live/current', target: '/srv/knowscroll/placeholder' },
    {
      path: '/srv/knowscroll/cutroom/current',
      target: `/srv/knowscroll/cutroom/releases/${'c'.repeat(40)}`,
    },
  ];
  const used = releasesInUse(links, RELEASES);
  assert.equal(used.ok, true);
  if (!used.ok) return;
  assert.deepEqual([...used.inUse].sort(), [V1, V2, V2_OLD, '9'.repeat(40)].sort());
  const releases = [V1, V2, V2_OLD, '9'.repeat(40), '4'.repeat(40), '5'.repeat(40)].map(
    (commit, i) => ({ commit, mtimeMs: i }),
  );
  assert.deepEqual(releasesToDelete(releases, used.inUse, 0).sort(), [
    '4'.repeat(40),
    '5'.repeat(40),
  ]);
});

test('#228 cleanup deletes nothing when a link cannot be read or names an unknown release', () => {
  assert.equal(
    releasesInUse(
      [{ path: '/srv/knowscroll/dev/current', target: null, error: 'EACCES' }],
      RELEASES,
    ).ok,
    false,
  );
  assert.equal(
    releasesInUse(
      [{ path: '/srv/knowscroll/dev/current', target: `${RELEASES}/v2-build-7` }],
      RELEASES,
    ).ok,
    false,
  );
  // A link into a release's own folder still names that release.
  const nested = releasesInUse(
    [{ path: '/srv/knowscroll/dev/current', target: `${RELEASES}/${V2}/web` }],
    RELEASES,
  );
  assert.deepEqual(nested.ok ? [...nested.inUse] : null, [V2]);
});

test('#228 v1 → v2 is refused while the world still has a paid Reel order to settle', () => {
  assert.equal(generationSwitchDecision('v1', 'v2', 0).ok, true);
  assert.equal(generationSwitchDecision('v1', 'v2', 1).ok, false);
  assert.equal(generationSwitchDecision('v1', 'v2', null).ok, false, 'unknown is refused');
  assert.equal(generationSwitchDecision(null, 'v2', null).ok, true, 'first deploy');
  assert.equal(generationSwitchDecision('v2', 'v2', null).ok, true);
  assert.equal(generationSwitchDecision('v2', 'v1', null).ok, true, 'rollback to v1');
});

test('#228 /health must name the world and commit, and for v2 the received artifact', () => {
  const artifact = hex('release');
  const body = { status: 'ok', world: 'dev', commit: V2, artifact, migration: '0002_content' };
  assert.equal(healthMatches(body, { world: 'dev', commit: V2, artifact }), true);
  assert.equal(
    healthMatches(body, { world: 'dev', commit: V2, artifact: hex('other build') }),
    false,
  );
  assert.equal(healthMatches(body, { world: 'stage', commit: V2, artifact }), false);
  assert.equal(healthMatches({ world: 'dev', commit: V1 }, { world: 'dev', commit: V1 }), true, 'v1');
  assert.equal(healthMatches('ok', { world: 'dev', commit: V1 }), false);
});

// ------------------------------------------------------------------------------------------------
// #228 review fixes
// ------------------------------------------------------------------------------------------------

/** An in-memory release for linkStaysInside: folders, files and links by relative path. */
function fakeTree(entries: Record<string, string | { link: string } | 'dir'>): FsView {
  return {
    kind(rel) {
      if (rel === '') return 'dir';
      const entry = entries[rel];
      if (entry === undefined) return 'missing';
      if (entry === 'dir') return 'dir';
      return typeof entry === 'string' ? 'file' : 'link';
    },
    readlink(rel) {
      const entry = entries[rel];
      if (typeof entry !== 'object') throw new Error(`${rel} is not a link`);
      return entry.link;
    },
  };
}

test('#228 M2: a link that reads as inside but climbs out through another link is refused', () => {
  // The reviewer's proof: s -> . keeps every s at the root, so four `..` reach the filesystem root.
  const poc = fakeTree({
    web: 'dir',
    'web/index.html': '<html>',
    s: { link: '.' },
    'web/escape': { link: '../s/s/s/s/../../../../etc' },
    x: { link: 's/s/s/s/../../../../etc' },
  });
  assert.equal(linkStaysInside(poc, 's').ok, true, 's -> . stays at the root');
  const escape = linkStaysInside(poc, 'web/escape');
  assert.equal(escape.ok, false);
  assert.match(escape.ok ? '' : escape.reason, /climbs out/);
  assert.equal(linkStaysInside(poc, 'x').ok, false);
});

test('#228 M2: pnpm-style relative links inside the release are accepted; dangling, absolute and looping ones are not', () => {
  const tree = fakeTree({
    api: 'dir',
    'api/node_modules': 'dir',
    'api/node_modules/.pnpm': 'dir',
    'api/node_modules/.pnpm/pg@8.0.0': 'dir',
    'api/node_modules/.pnpm/pg@8.0.0/node_modules': 'dir',
    'api/node_modules/.pnpm/pg@8.0.0/node_modules/pg': 'dir',
    'api/node_modules/.pnpm/pg@8.0.0/node_modules/pg/index.js': 'x',
    'api/node_modules/.pnpm/pg@8.0.0/node_modules/pg-types': {
      link: '../../pg-types@4.0.0/node_modules/pg-types',
    },
    'api/node_modules/.pnpm/pg-types@4.0.0': 'dir',
    'api/node_modules/.pnpm/pg-types@4.0.0/node_modules': 'dir',
    'api/node_modules/.pnpm/pg-types@4.0.0/node_modules/pg-types': 'dir',
    'api/node_modules/pg': { link: '.pnpm/pg@8.0.0/node_modules/pg' },
    'api/node_modules/dangling': { link: '.pnpm/nothing' },
    'api/node_modules/absolute': { link: '/etc' },
    'api/a': { link: 'b' },
    'api/b': { link: 'a' },
    'api/file': 'x',
    'api/through-file': { link: 'file/inside' },
  });
  assert.deepEqual(linkStaysInside(tree, 'api/node_modules/pg'), {
    ok: true,
    value: 'api/node_modules/.pnpm/pg@8.0.0/node_modules/pg',
  });
  assert.equal(
    linkStaysInside(tree, 'api/node_modules/.pnpm/pg@8.0.0/node_modules/pg-types').ok,
    true,
  );
  assert.match(
    (() => {
      const r = linkStaysInside(tree, 'api/node_modules/dangling');
      return r.ok ? '' : r.reason;
    })(),
    /points at nothing/,
  );
  assert.match(
    (() => {
      const r = linkStaysInside(tree, 'api/node_modules/absolute');
      return r.ok ? '' : r.reason;
    })(),
    /absolute/,
  );
  assert.equal(linkStaysInside(tree, 'api/a').ok, false, 'a loop');
  assert.equal(linkStaysInside(tree, 'api/through-file').ok, false);
});

test('#228 M2: files.sha256 lists links by their target; a retargeted or unlisted link is refused', () => {
  const actual = new Map([
    ['api/dist/main.js', hex('api')],
    ['api/node_modules/pg', symlinkHash('.pnpm/pg@8.0.0/node_modules/pg')],
  ]);
  const listing = [...actual].map(([p, h]) => `${h}  ${p}\n`).join('');
  assert.equal(checkFileList(listing, actual).ok, true);
  assert.notEqual(symlinkHash('a'), symlinkHash('b'));
  assert.notEqual(symlinkHash('x'), hex('x'), 'a link never hashes like a file with that text');
  const retargeted = new Map(actual).set('api/node_modules/pg', symlinkHash('../../../../etc'));
  assert.match(
    (() => {
      const r = checkFileList(listing, retargeted);
      return r.ok ? '' : r.reason;
    })(),
    /hash mismatch api\/node_modules\/pg/,
  );
  const extraLink = new Map(actual).set('web/escape', symlinkHash('../etc'));
  assert.match(
    (() => {
      const r = checkFileList(listing, extraLink);
      return r.ok ? '' : r.reason;
    })(),
    /not listed web\/escape/,
  );
});

/** A tar archive built by hand: POSIX ustar headers (or GNU magic), data padded to 512 bytes. */
function tarOf(
  entries: Array<{ name: string; type: string; data?: string; link?: string; gnu?: boolean }>,
): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? '');
    const h = Buffer.alloc(512);
    h.write(entry.name, 0, 100, 'utf8');
    h.write('0000644\0', 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148);
    h.write(entry.type, 156);
    h.write(entry.link ?? '', 157, 100, 'utf8');
    if (entry.gnu) h.write('ustar  \0', 257);
    else {
      h.write('ustar\0', 257);
      h.write('00', 263);
    }
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

function listTar(archive: Buffer) {
  return tarEntries((offset, length) => archive.subarray(offset, offset + length), archive.length);
}

function tarVerdict(entries: Parameters<typeof tarOf>[0]): string {
  const listed = listTar(tarOf(entries));
  if (!listed.ok) return listed.reason;
  const checked = checkTarEntries(listed.value);
  return checked.ok ? 'ok' : checked.reason;
}

test('#228 m6: a tar archive is listed from its headers, GNU long names included', () => {
  const longName = `api/node_modules/${'a'.repeat(120)}/index.js`;
  const listed = listTar(
    tarOf([
      { name: 'release.json', type: '0', data: '{}' },
      { name: 'api/', type: '5' },
      { name: '././@LongLink', type: 'L', data: `${longName}\0`, gnu: true },
      { name: longName.slice(0, 99), type: '0', data: 'x', gnu: true },
      { name: 'api/node_modules/pg', type: '2', link: '.pnpm/pg@8.0.0/node_modules/pg' },
      { name: 'api/copy.js', type: '1', link: 'release.json' },
    ]),
  );
  assert.equal(listed.ok, true);
  assert.deepEqual(
    listed.ok ? listed.value.map((e) => [e.path, e.type]) : null,
    [
      ['release.json', '0'],
      ['api/', '5'],
      [longName, '0'],
      ['api/node_modules/pg', '2'],
      ['api/copy.js', '1'],
    ],
  );
  assert.equal(checkTarEntries(listed.ok ? listed.value : []).ok, true);
});

test('#228 m6: devices, FIFOs, absolute paths, .. and writes through links are refused before extraction', () => {
  assert.match(tarVerdict([{ name: 'dev/null', type: '3' }]), /not a file, a folder or a link/);
  assert.match(tarVerdict([{ name: 'dev/sda', type: '4' }]), /not a file, a folder or a link/);
  assert.match(tarVerdict([{ name: 'web/pipe', type: '6' }]), /not a file, a folder or a link/);
  assert.match(tarVerdict([{ name: '/etc/passwd', type: '0', data: 'x' }]), /unsafe path/);
  assert.match(tarVerdict([{ name: 'web/../../etc/x', type: '0' }]), /unsafe path/);
  assert.match(
    tarVerdict([
      { name: 'web/out', type: '2', link: '../../..' },
      { name: 'web/out/cron.d/x', type: '0', data: 'x' },
    ]),
    /written through a link/,
  );
  assert.match(tarVerdict([{ name: 'web/abs', type: '2', link: '/etc' }]), /absolute/);
  assert.match(
    tarVerdict([{ name: 'api/shadow', type: '1', link: 'etc/shadow' }]),
    /hard link/,
  );
  assert.match(tarVerdict([{ name: '.ks/release.env', type: '0' }]), /\.ks/);
  assert.match(
    tarVerdict([
      { name: 'a.js', type: '0' },
      { name: 'a.js', type: '2', link: 'b' },
    ]),
    /twice/,
  );
  // v1 archives name entries with a leading ./ and that is fine.
  assert.equal(
    tarVerdict([
      { name: './', type: '5' },
      { name: './dist/api.mjs', type: '0', data: 'x' },
    ]),
    'ok',
  );
  const corrupt = tarOf([{ name: 'a', type: '0' }]);
  corrupt[0] = 'b'.charCodeAt(0);
  assert.equal(listTar(corrupt).ok, false, 'a header whose checksum is wrong');
});

test('#228 m1: a failed deploy leaves current and previous exactly as they were', () => {
  const v1 = `/srv/knowscroll/releases/${V1}`;
  const v2old = `/srv/knowscroll/releases/${V2_OLD}`;
  const v2 = `/srv/knowscroll/releases/${V2}`;
  const before = { current: v2old, previous: v1 };
  assert.deepEqual(linksAfterDeploy(before, v2, V2, false), before);
  assert.deepEqual(linksAfterDeploy(before, v2, V2, true), { current: v2, previous: v2old });
  // Redeploying what runs keeps the way back.
  assert.deepEqual(linksAfterDeploy({ current: v2, previous: v1 }, v2, V2, true), {
    current: v2,
    previous: v1,
  });
  // The first deploy over the placeholder.
  assert.deepEqual(
    linksAfterDeploy({ current: '/srv/knowscroll/placeholder', previous: null }, v2, V2, true),
    { current: v2, previous: '/srv/knowscroll/placeholder' },
  );
  assert.equal(commitOfTarget(v2), V2);
  assert.equal(commitOfTarget(`${v2}/`), V2);
  assert.equal(commitOfTarget('/srv/knowscroll/placeholder'), null);
});

test('#228 m8: a rollback swaps the links, and a failed one puts them back', () => {
  const before = { current: `/r/releases/${V2}`, previous: `/r/releases/${V1}` };
  assert.deepEqual(linksAfterRollback(before, true), {
    current: `/r/releases/${V1}`,
    previous: `/r/releases/${V2}`,
  });
  assert.deepEqual(linksAfterRollback(before, false), before);
});

test('#228 m2, m7: which commands hold the deploy lock', () => {
  assert.equal(lockNeeded('deploy', ['dev', A]), 'wait');
  assert.equal(lockNeeded('promote', ['stage', A]), 'wait');
  assert.equal(lockNeeded('rollback', ['dev']), 'wait');
  assert.equal(lockNeeded('cleanup', []), 'wait');
  assert.equal(lockNeeded('run', ['dev', 'generation-cli', 'order']), 'wait', 'it can claim a paid order');
  assert.equal(lockNeeded('run', ['dev', 'publication']), 'none');
  assert.equal(lockNeeded('disk-guard', []), 'try', 'the disk guard never waits');
  assert.equal(lockNeeded('status', []), 'none');
  assert.equal(lockNeeded('has-release', [A]), 'none');
});

test('#228 m2: the deploy lock counts as held only when ks\'s parent holds a write flock on it', () => {
  const locks = [
    '1: POSIX  ADVISORY  WRITE 900 fd:01:5555 0 EOF',
    '2: FLOCK  ADVISORY  WRITE 4242 fd:01:777 0 EOF',
    '2: -> FLOCK  ADVISORY  WRITE 5000 fd:01:777 0 EOF',
    '3: FLOCK  ADVISORY  READ 4343 fd:01:888 0 EOF',
  ].join('\n');
  assert.equal(deployLockHeldByParent(locks, 777, 4242), true);
  assert.equal(deployLockHeldByParent(locks, 777, 5000), false, 'a waiter does not hold it');
  assert.equal(deployLockHeldByParent(locks, 777, 1), false, 'someone else holds it');
  assert.equal(deployLockHeldByParent(locks, 888, 4343), false, 'a shared lock is not the deploy lock');
  assert.equal(deployLockHeldByParent(locks, 5555, 900), false, 'a POSIX lock is not flock');
});

test('#228 m7: cleanup runs every step even when one fails, and says which failed', () => {
  const ran: string[] = [];
  const result = runSteps([
    {
      name: 'releases',
      run: () => {
        throw new Error('cannot read /srv/knowscroll/dev/current');
      },
    },
    { name: 'interrupted uploads', run: () => ran.push('uploads') },
    { name: 'journal', run: () => ran.push('journal') },
  ]);
  assert.deepEqual(ran, ['uploads', 'journal']);
  assert.deepEqual(result.failed, [
    { step: 'releases', reason: 'cannot read /srv/knowscroll/dev/current' },
  ]);
});

test('#228 m10: a v2 migrate gets its own statement timeout in its session, not from the role', () => {
  const url = withSessionOptions('postgresql://ks2_dev:secret@127.0.0.1:5432/knowscroll_v2_dev', {
    statement_timeout: '15min',
  });
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('options'), '-c statement_timeout=15min');
  assert.equal(parsed.pathname, '/knowscroll_v2_dev');
  assert.match(url, /options=-c%20statement_timeout%3D15min$/, 'spaces as %20, never +');
  const merged = new URL(
    withSessionOptions('postgresql://u:p@h/db?sslmode=disable&options=-c%20a%3D1', { b: '2' }),
  );
  assert.equal(merged.searchParams.get('sslmode'), 'disable');
  assert.equal(merged.searchParams.get('options'), '-c a=1 -c b=2');
});

test('#228 m10: the pre-migrate dump is named by UTC time and commit, so names sort by time', () => {
  assert.equal(
    predeployDumpName(new Date('2026-10-19T12:34:56.789Z'), V2),
    `pre-deploy-20261019T123456Z-${V2.slice(0, 12)}.dump`,
  );
  const earlier = predeployDumpName(new Date('2026-10-19T09:00:00Z'), V1);
  const later = predeployDumpName(new Date('2026-10-20T08:00:00Z'), V1);
  assert.ok(earlier < later);
});

test('#228 m4: a release checksum file is exactly one line naming exactly that tar', () => {
  const tar = `release-${V2}.tar`;
  const h = hex('tar');
  assert.deepEqual(checksumFor(`${h}  ${tar}\n`, tar), { ok: true, value: h });
  assert.equal(checksumFor(`${h}  ${tar}\n${h}  other.tar\n`, tar).ok, false, 'two lines');
  assert.equal(checksumFor(`${h}  other.tar\n`, tar).ok, false, 'another file');
  assert.equal(checksumFor(`${h} ${tar}\n`, tar).ok, false, 'one space');
  assert.equal(checksumFor('', tar).ok, false);
});
