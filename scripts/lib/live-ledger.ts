/**
 * #132 — the session ledger of live MiniMax requests under $KS_DEV_ROOT, shared by the live runners
 * (`scripts/run-live-answer-experiment.ts`, `scripts/run-live-inquiry-experiment.ts`) and the Android
 * journey's live opt-in: every live request counts against one bounded session allowance.
 *
 * #153: a live run holds the ledger's lock (a file created exclusively next to it) from its allowance
 * check until its count is written, so two runs started at once cannot both pass the check. A lock left
 * by a run that died is never taken over: the next run refuses and names it, to be removed by hand once
 * no live run is active.
 */
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';

export type LiveLedger = { sessionCap: number; used: number; runs: { at: string; dispatched: number; database: string; kind?: string }[] };
export const LIVE_SESSION_CAP = 40;

export function openLiveLedger(devRoot: string): { ledger: LiveLedger; save(): void; release(): void } {
  const path = resolve(devRoot, 'minimax-answer-session-ledger.json');
  const lock = `${path}.lock`;
  let fd: number;
  try { fd = openSync(lock, 'wx'); } catch { throw new Error(`Refusing: another live run holds ${lock}; remove it only once no live run is active.`); }
  writeSync(fd, String(process.pid));
  closeSync(fd);
  const release = () => unlinkSync(lock);
  let ledger: LiveLedger;
  try { ledger = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { sessionCap: LIVE_SESSION_CAP, used: 0, runs: [] }; }
  catch (error) { release(); throw error; }
  return { ledger, save: () => writeFileSync(path, JSON.stringify(ledger, null, 2)), release };
}
