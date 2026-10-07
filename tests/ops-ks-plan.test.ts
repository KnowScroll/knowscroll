/**
 * #201 — the server tool's decisions, without touching a server: which deploys are allowed,
 * which releases cleanup may delete, what the disk guard does at each level, and how a world's
 * env file is read. The side effects that act on these decisions live in ops/vps/tool/system.ts.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cutroomSwitchDecision,
  diskGuardDecision,
  parseEnvFile,
  releasesToDelete,
  validateDeployRequest,
  validateRunRequest,
} from '../ops/vps/tool/plan.ts';

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
