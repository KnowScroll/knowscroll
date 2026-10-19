/**
 * #201 — the server tool's decisions, without touching a server: which deploys are allowed,
 * which releases cleanup may delete, what the disk guard does at each level, and how a world's
 * env file is read. The side effects that act on these decisions live in ops/vps/tool/system.ts.
 *
 * #228 — v2 releases: which generation a release is, what a v2 release.json and files.sha256 must
 * say, how a world switches between v1 and v2 (and back on a failed deploy), and that cleanup
 * keeps every release a world uses whatever its generation.
 *
 *   node --test ops/vps/tool/plan.test.ts
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  activationPlan,
  afterFailedDeploy,
  checkFileList,
  cutroomSwitchDecision,
  diskGuardDecision,
  generationSwitchDecision,
  healthMatches,
  isSafeFilePath,
  parseEnvFile,
  parseSha256List,
  releaseGeneration,
  releasesInUse,
  releasesToDelete,
  validateDeployRequest,
  validateRunRequest,
  validateV2Manifest,
} from './plan.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

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
