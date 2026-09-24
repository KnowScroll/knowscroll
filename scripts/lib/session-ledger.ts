/**
 * The persistent MiniMax session ledger (`$KS_DEV_ROOT/minimax-answer-session-ledger.json`, owner
 * decisions of 2026-09-24): the cap on live requests for this session (`sessionCap`), how many were
 * used, and each run. Every live tool counts through this module, under one lock file created
 * exclusively next to the ledger (#153, #181):
 *
 * - `holdLedger` holds it for a whole run (the live experiments, the Android journey through this
 *   file's command line): from the allowance check until the run's count is written, so two runs
 *   started at once cannot both pass the check;
 * - `countLedgerRequest` holds it for one request, counted before it is sent (`write-scrolls.ts`).
 *
 * The ledger is re-read under the lock, a missing one is refused (never created), and each count is
 * written durably (fsynced, then renamed into place). A run whose requests cannot be counted keeps the
 * lock, and a lock left by a crashed process is never broken here: the operator checks the ledger and
 * removes it by hand once no live run is active.
 */
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

// Fields another tool wrote are kept as they are.
const ledgerSchema = z.object({
  sessionCap: z.number().int().min(0),
  used: z.number().int().min(0),
  runs: z.array(z.object({ at: z.string(), dispatched: z.number().int().min(0), database: z.string(), kind: z.string().optional() }).passthrough()),
}).passthrough();
type Ledger = z.infer<typeof ledgerSchema>;
export type LedgerRefusal = 'ledger_missing' | 'ledger_invalid' | 'ledger_locked' | 'session_cap_reached';
export type LedgerRun = { at: string; database: string; kind: string };

export const sessionLedgerPath = (devRoot: string) => resolve(devRoot, 'minimax-answer-session-ledger.json');

function readLedger(path: string): { ok: true; ledger: Ledger } | { ok: false; reason: 'ledger_missing' | 'ledger_invalid' } {
  if (!existsSync(path)) return { ok: false, reason: 'ledger_missing' };
  let parsed: ReturnType<typeof ledgerSchema.safeParse>;
  try { parsed = ledgerSchema.safeParse(JSON.parse(readFileSync(path, 'utf8'))); } catch { return { ok: false, reason: 'ledger_invalid' }; }
  return parsed.success ? { ok: true, ledger: parsed.data } : { ok: false, reason: 'ledger_invalid' };
}

function writeDurably(path: string, text: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  const fd = openSync(temporary, 'w', 0o600);
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
}

/** A run holding the ledger's lock. */
export interface HeldLedger {
  readonly token: string;
  /** Counts the run's requests durably, then releases the lock. Throws, keeping the lock, if the count cannot be written. */
  record(run: LedgerRun, dispatched: number): { used: number; cap: number };
  /** Releases the lock without counting (nothing was sent); nothing once the run was recorded. */
  release(): void;
}

/** The lock `token` names, taken by this process or another (the Android journey holds it across commands). */
function heldLedger(path: string, token: string): HeldLedger {
  const lock = `${path}.lock`;
  let open = true;
  const own = () => { if (readFileSync(lock, 'utf8') !== token) throw new Error(`The session ledger lock ${lock} is not this run's`); };
  const unlock = () => { own(); unlinkSync(lock); open = false; };
  return {
    token,
    record(run, dispatched) {
      own();
      const read = readLedger(path);
      if (!read.ok) throw new Error(`The session ledger cannot be counted: ${read.reason}`);
      const { ledger } = read;
      let entry = ledger.runs.find(r => r.at === run.at && r.database === run.database && r.kind === run.kind);
      if (!entry) { entry = { ...run, dispatched: 0 }; ledger.runs.push(entry); }
      entry.dispatched += dispatched;
      ledger.used += dispatched;
      writeDurably(path, `${JSON.stringify(ledger, null, 2)}\n`);
      unlock();
      return { used: ledger.used, cap: ledger.sessionCap };
    },
    release() { if (open) unlock(); },
  };
}

/** Takes the lock (waiting a little for another tool's count), then checks that the allowance covers `need` more requests. */
export async function holdLedger(path: string, need: number, options: { lockWaitMs?: number } = {}):
  Promise<{ ok: true; held: HeldLedger; used: number; cap: number } | { ok: false; reason: LedgerRefusal }> {
  const lock = `${path}.lock`;
  const token = randomBytes(16).toString('hex');
  const deadline = Date.now() + (options.lockWaitMs ?? 5_000);
  for (;;) {
    try { const fd = openSync(lock, 'wx', 0o600); try { writeSync(fd, token); } finally { closeSync(fd); } break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) return { ok: false, reason: 'ledger_locked' };
      await sleep(25);
    }
  }
  const held = heldLedger(path, token);
  const read = readLedger(path);
  if (!read.ok || read.ledger.used + need > read.ledger.sessionCap) {
    held.release();
    return { ok: false, reason: read.ok ? 'session_cap_reached' : read.reason };
  }
  return { ok: true, held, used: read.ledger.used, cap: read.ledger.sessionCap };
}

/** Counts one request before it is sent: a count that cannot be written was never sent, so the lock is released either way. */
export async function countLedgerRequest(path: string, run: LedgerRun, options: { lockWaitMs?: number } = {}):
  Promise<{ ok: true; used: number; cap: number } | { ok: false; reason: LedgerRefusal }> {
  const hold = await holdLedger(path, 1, options);
  if (!hold.ok) return hold;
  try { return { ok: true, ...hold.held.record(run, 1) }; } finally { hold.held.release(); }
}

/**
 * For a tool in another language (`scripts/android-semantic-journey.py`), the ledger under $KS_DEV_ROOT:
 *   hold <need>                                   → {"token", "used", "cap"}
 *   record <token> <dispatched> <database> <kind> → {"used", "cap"}, lock released
 *   release <token>                               → {"released": true}, nothing counted
 * A refusal prints `Refusing: …` and exits 2.
 */
async function main([command, ...args]: string[]): Promise<number> {
  if (!process.env.KS_DEV_ROOT) { console.error('Refusing: source scripts/env.sh first: the session ledger lives under KS_DEV_ROOT.'); return 2; }
  const path = sessionLedgerPath(process.env.KS_DEV_ROOT);
  if (command === 'hold' && args.length === 1 && /^[1-9]\d*$/.test(args[0]!)) {
    const hold = await holdLedger(path, Number(args[0]));
    if (!hold.ok) { console.error(`Refusing: the session ledger (${path}): ${hold.reason}`); return 2; }
    console.log(JSON.stringify({ token: hold.held.token, used: hold.used, cap: hold.cap }));
    return 0;
  }
  if (command === 'record' && args.length === 4 && /^\d+$/.test(args[1]!)) {
    const [token, dispatched, database, kind] = args as [string, string, string, string];
    console.log(JSON.stringify(heldLedger(path, token).record({ at: new Date().toISOString(), database, kind }, Number(dispatched))));
    return 0;
  }
  if (command === 'release' && args.length === 1) {
    heldLedger(path, args[0]!).release();
    console.log(JSON.stringify({ released: true }));
    return 0;
  }
  console.error('Refusing: hold <need> | record <token> <dispatched> <database> <kind> | release <token>');
  return 2;
}

// pathToFileURL, not string concatenation: the SSD path contains a space (verify-substrate.ts).
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
