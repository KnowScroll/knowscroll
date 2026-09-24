/**
 * #153/#181 — every live tool counts its MiniMax requests in the one session ledger through
 * `scripts/lib/session-ledger.ts`, under its one lock file. A run (the live experiments, the Android
 * journey) holds the lock from its allowance check until its count is written, so neither a second run
 * nor `write-scrolls.ts`'s per-request count gets past it; a refusal releases it, and a run whose count
 * cannot be written keeps it for counting by hand. A missing ledger is refused, never created. The
 * Android journey holds and counts from another process through the module's command line. A
 * temporary directory stands in for $KS_DEV_ROOT.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { countLedgerRequest, holdLedger, sessionLedgerPath } from '../scripts/lib/session-ledger.ts';

const at = new Date().toISOString();
function ledgerIn(ledger: unknown): { devRoot: string; path: string; done(): void } {
  const devRoot = mkdtempSync(join(tmpdir(), 'session-ledger-'));
  const path = sessionLedgerPath(devRoot);
  if (ledger !== undefined) writeFileSync(path, JSON.stringify(ledger));
  return { devRoot, path, done: () => rmSync(devRoot, { recursive: true, force: true }) };
}
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

test('a run holds the ledger from its allowance check until its count is written; no other tool counts meanwhile', async () => {
  const l = ledgerIn({ sessionCap: 5, used: 1, runs: [{ at: 'earlier', dispatched: 1, database: 'x', kind: 'scroll' }], note: 'kept' });
  try {
    const first = await holdLedger(l.path, 2);
    assert.ok(first.ok, JSON.stringify(first));
    assert.deepEqual([first.used, first.cap], [1, 5]);
    assert.deepEqual(await holdLedger(l.path, 1, { lockWaitMs: 100 }), { ok: false, reason: 'ledger_locked' }, 'a second run');
    assert.deepEqual(await countLedgerRequest(l.path, { at, database: 'db', kind: 'scroll' }, { lockWaitMs: 100 }), { ok: false, reason: 'ledger_locked' },
      'write-scrolls.ts counts under the same lock');
    assert.deepEqual(first.held.record({ at, database: 'db', kind: 'inquiry' }, 2), { used: 3, cap: 5 });
    first.held.release();
    assert.equal(existsSync(`${l.path}.lock`), false, 'recording released the lock');
    assert.deepEqual([read(l.path).used, read(l.path).runs.at(-1), read(l.path).note], [3, { at, database: 'db', kind: 'inquiry', dispatched: 2 }, 'kept']);

    // The allowance covers the whole run, or the run never starts; a refusal leaves the lock free.
    assert.deepEqual(await holdLedger(l.path, 3), { ok: false, reason: 'session_cap_reached' });
    assert.equal(existsSync(`${l.path}.lock`), false);
    const last = await holdLedger(l.path, 2);
    assert.ok(last.ok);
    last.held.release();
    assert.equal(read(l.path).used, 3, 'released without counting: nothing was sent');
  } finally { l.done(); }
});

test('a missing ledger is refused, never created, and a count that cannot be written keeps the lock', async () => {
  const missing = ledgerIn(undefined);
  try {
    assert.deepEqual(await holdLedger(missing.path, 1), { ok: false, reason: 'ledger_missing' });
    assert.equal(existsSync(missing.path), false);
    assert.equal(existsSync(`${missing.path}.lock`), false);
  } finally { missing.done(); }

  const l = ledgerIn({ sessionCap: 5, used: 0, runs: [] });
  try {
    const held = await holdLedger(l.path, 1);
    assert.ok(held.ok);
    writeFileSync(l.path, 'not a ledger');
    assert.throws(() => held.held.record({ at, database: 'db', kind: 'answer' }, 1), /ledger_invalid/);
    assert.equal(existsSync(`${l.path}.lock`), true, 'kept, so no further run starts before the requests are counted by hand');
  } finally { l.done(); }
});

test('the Android journey holds and counts from another process, through the same lock', async () => {
  const l = ledgerIn({ sessionCap: 4, used: 2, runs: [] });
  const cli = (...args: string[]) => promisify(execFile)('pnpm', ['exec', 'tsx', 'scripts/lib/session-ledger.ts', ...args],
    { env: { ...process.env, KS_DEV_ROOT: l.devRoot }, timeout: 20_000 });
  try {
    const held = JSON.parse((await cli('hold', '1')).stdout);
    assert.deepEqual([held.used, held.cap, typeof held.token], [2, 4, 'string']);
    assert.deepEqual(await countLedgerRequest(l.path, { at, database: 'db', kind: 'scroll' }, { lockWaitMs: 100 }), { ok: false, reason: 'ledger_locked' });
    await assert.rejects(cli('record', 'not-the-token', '1', 'db', 'android-ask-journey'), /not this run's/);
    assert.deepEqual(JSON.parse((await cli('record', held.token, '1', 'db', 'android-ask-journey')).stdout), { used: 3, cap: 4 });
    assert.equal(existsSync(`${l.path}.lock`), false);
    assert.deepEqual(read(l.path).runs.map((r: { database: string; kind: string; dispatched: number }) => [r.database, r.kind, r.dispatched]), [['db', 'android-ask-journey', 1]]);

    await assert.rejects(cli('hold', '2'), (error: { code: number; stderr: string }) => error.code === 2 && /session_cap_reached/.test(error.stderr));
    const again = JSON.parse((await cli('hold', '1')).stdout);
    assert.deepEqual(JSON.parse((await cli('release', again.token)).stdout), { released: true });
    assert.equal(existsSync(`${l.path}.lock`), false);
    assert.equal(read(l.path).used, 3);
  } finally { l.done(); }
});
