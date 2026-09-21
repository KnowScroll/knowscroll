/**
 * Proves scripts/demo-populate.ts's refusal to run against anything but a knowscroll_demo_*
 * database, in two independent ways:
 *
 *  1. `assertDemoDatabaseName` itself, as a pure function — no database, no process, no network.
 *     This is the primary proof: the guard module imports nothing from `pg` or `packages/db`, so
 *     these assertions alone establish the refusal has nothing to do with whether a connection
 *     would have succeeded.
 *  2. A real subprocess run of demo-populate.ts pointed at a non-demo database name on an
 *     unroutable address (RFC 5737 TEST-NET-1, guaranteed never to answer). If the guard ran after
 *     opening a connection, this would hang for the OS-level TCP connect timeout (tens of seconds);
 *     because the guard runs first and demo-populate.ts never even imports `pg` until after it
 *     passes, the process instead exits within a couple of seconds, with the guard's own message —
 *     never a connection error.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertDemoDatabaseName, NotADemoDatabaseError } from '../scripts/lib/demo-database-guard.ts';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('assertDemoDatabaseName accepts only a knowscroll_demo_* database name', () => {
  assert.equal(assertDemoDatabaseName('postgresql://u:p@127.0.0.1:5432/knowscroll_demo_full'), 'knowscroll_demo_full');
  assert.equal(assertDemoDatabaseName('postgresql://u:p@127.0.0.1:5432/knowscroll_demo_x'), 'knowscroll_demo_x');
});

test('assertDemoDatabaseName refuses the owner database, test databases, and everything else', () => {
  for (const url of [
    'postgresql://u:p@127.0.0.1:5432/knowscroll',
    'postgresql://u:p@127.0.0.1:5432/knowscroll_test_abc123',
    'postgresql://u:p@127.0.0.1:5432/knowscroll_demo', // missing the trailing underscore + name
    'postgresql://u:p@127.0.0.1:5432/postgres',
    'postgresql://u:p@127.0.0.1:5432/production',
  ]) {
    assert.throws(() => assertDemoDatabaseName(url), NotADemoDatabaseError, `should refuse ${url}`);
  }
});

test('assertDemoDatabaseName refuses a missing or malformed DATABASE_URL', () => {
  assert.throws(() => assertDemoDatabaseName(undefined));
  assert.throws(() => assertDemoDatabaseName('not-a-url'));
});

test('assertDemoDatabaseName refuses a database name it will not safely interpolate into SQL', () => {
  assert.throws(() => assertDemoDatabaseName('postgresql://u:p@127.0.0.1:5432/knowscroll_demo_%22%3Bdrop'));
});

test('demo-populate.ts refuses a non-demo database before opening any connection (subprocess, unroutable host)', async () => {
  const start = Date.now();
  await assert.rejects(
    execFileAsync(
      'pnpm', ['exec', 'tsx', 'scripts/demo-populate.ts', '--stage', 'empty'],
      {
        cwd: root,
        timeout: 8_000,
        env: {
          ...process.env,
          // TEST-NET-1 (RFC 5737): reserved for documentation, guaranteed not to route anywhere
          // that will ever answer. If demo-populate.ts tried to connect before checking the name,
          // this would time out slowly instead of failing fast with the guard's own message.
          DATABASE_URL: 'postgresql://u:p@192.0.2.1:5432/knowscroll_not_a_demo_database',
        },
      },
    ),
    (error: unknown) => {
      const { stdout = '', stderr = '' } = error as { stdout?: string; stderr?: string };
      assert.ok(
        `${stdout}${stderr}`.includes('does not begin "knowscroll_demo_"'),
        `expected the guard's own refusal, got:\n${stdout}\n${stderr}`,
      );
      return true;
    },
  );
  const elapsedMs = Date.now() - start;
  // The subprocess's own hard timeout above is 8s, well past any real OS TCP-connect timeout to an
  // unroutable address; a genuine connection attempt would still be pending well past 3s, so a
  // sub-3s exit is strong evidence the guard ran before any socket was opened.
  assert.ok(
    elapsedMs < 3_000,
    `demo-populate.ts took ${elapsedMs}ms against an unroutable host; the guard must refuse before any connection is attempted`,
  );
});
