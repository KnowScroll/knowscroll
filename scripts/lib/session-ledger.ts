/**
 * The persistent MiniMax session ledger (`$KS_DEV_ROOT/minimax-answer-session-ledger.json`, owner
 * decisions of 2026-09-24): the cap on live requests for this session (`sessionCap`), how many were
 * used, and each run. `countLedgerRequest` counts one request before it is sent: under an exclusive
 * lock file it re-reads the ledger, refuses at the cap, and writes the increment durably (fsynced,
 * then renamed into place). Two processes can never both take the last request, and a crash after
 * sending still counted it. A lock left by a crashed process is never broken here: the operator
 * checks the ledger and removes it by hand.
 */
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';

// Fields another tool wrote are kept as they are.
const ledgerSchema = z.object({
  sessionCap: z.number().int().min(0),
  used: z.number().int().min(0),
  runs: z.array(z.object({ at: z.string(), dispatched: z.number().int().min(0), database: z.string(), kind: z.string().optional() }).passthrough()),
}).passthrough();
export type LedgerRefusal = 'ledger_missing' | 'ledger_invalid' | 'ledger_locked' | 'session_cap_reached';

function writeDurably(path: string, text: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  const fd = openSync(temporary, 'w', 0o600);
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
}

export async function countLedgerRequest(path: string, run: { at: string; database: string; kind: string }, options: { lockWaitMs?: number } = {}):
  Promise<{ ok: true; used: number; cap: number } | { ok: false; reason: LedgerRefusal }> {
  const lock = `${path}.lock`;
  const deadline = Date.now() + (options.lockWaitMs ?? 5_000);
  for (;;) {
    try { closeSync(openSync(lock, 'wx')); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) return { ok: false, reason: 'ledger_locked' };
      await sleep(25);
    }
  }
  try {
    if (!existsSync(path)) return { ok: false, reason: 'ledger_missing' };
    let parsed: ReturnType<typeof ledgerSchema.safeParse>;
    try { parsed = ledgerSchema.safeParse(JSON.parse(readFileSync(path, 'utf8'))); } catch { return { ok: false, reason: 'ledger_invalid' }; }
    if (!parsed.success) return { ok: false, reason: 'ledger_invalid' };
    const ledger = parsed.data;
    if (ledger.used >= ledger.sessionCap) return { ok: false, reason: 'session_cap_reached' };
    let entry = ledger.runs.find(r => r.at === run.at && r.database === run.database && r.kind === run.kind);
    if (!entry) { entry = { ...run, dispatched: 0 }; ledger.runs.push(entry); }
    entry.dispatched += 1;
    ledger.used += 1;
    writeDurably(path, `${JSON.stringify(ledger, null, 2)}\n`);
    return { ok: true, used: ledger.used, cap: ledger.sessionCap };
  } finally { unlinkSync(lock); }
}
