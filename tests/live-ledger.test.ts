/**
 * #153 — the live runners' session ledger is held by one run at a time: a second run started while the
 * first holds it is refused before it can check the allowance, and the first run's count is what the
 * next run reads once it is released. A temporary directory stands in for $KS_DEV_ROOT.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLiveLedger } from '../scripts/lib/live-ledger.ts';

test('two live runs started at once cannot both pass the allowance check', () => {
  const devRoot = mkdtempSync(join(tmpdir(), 'live-ledger-'));
  try {
    const first = openLiveLedger(devRoot);
    assert.deepEqual([first.ledger.used, first.ledger.sessionCap], [0, 40]);
    assert.throws(() => openLiveLedger(devRoot), /another live run holds/);
    first.ledger.used += 2;
    first.save();
    first.release();
    const next = openLiveLedger(devRoot);
    assert.equal(next.ledger.used, 2, 'the next run reads the first run\'s count');
    next.release();
  } finally { rmSync(devRoot, { recursive: true, force: true }); }
});
