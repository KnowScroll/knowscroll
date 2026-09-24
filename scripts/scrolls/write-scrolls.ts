/**
 * #162 — the operator CLI for model-written Scrolls (ADR-0041 §8).
 *
 *   pnpm exec tsx scripts/scrolls/write-scrolls.ts --database knowscroll_test_… --plan plan.json \
 *     --transport fixture|minimax [--fixture-mode scroll] [--apply]
 *
 * The plan is a JSON array of `{"url": "https://…", "conceptCodes": ["…"]}`: one allowlisted page
 * and one to eight existing concept codes each, the first being what the Scroll is about. The
 * database must be a disposable `knowscroll_test_*` or `knowscroll_demo_*` database, migrated and
 * seeded; its name is checked before any database module is loaded, and the connection is the local
 * DATABASE_URL (environment, else `.env`) with that name.
 *
 * Without `--apply` every page is fetched and its request built and hashed; nothing is sent or
 * written. `--transport minimax` needs a subscription (`sk-cp-`) key in MINIMAX_API_KEY, from the
 * environment only. With `--apply` it runs, before each request, the quota preflight (at least 25%
 * of the interval and weekly allowance), then counts the request in the session ledger
 * (`$KS_DEV_ROOT/minimax-answer-session-ledger.json`) under its lock; a missing ledger is refused.
 * The run stops at the first refusal of the route: the preflight, the ledger, a provider error or a
 * lost transport. A refused reply is not one; the run goes on. The receipt
 * (`artifacts/scroll-writing/`, ignored) holds counts, statuses, reason codes, hashes, input bytes
 * and token usage: never a prompt, a reply or a key.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { createMiniMaxAnswerTransport } from '../../apps/worker/src/providers/minimax-answer.ts';
import { createFixtureScrollTransport, SCROLL_FIXTURE_MODES, type ScrollFixtureMode } from '../../apps/worker/src/providers/scroll-fixture.ts';
import type { ScrollItemResult, ScrollTransport, WriteScrollDeps } from '../../apps/worker/src/scrolls/write-scroll.ts';
import { MATERIAL_POLICY_VERSION } from '../../packages/core/src/scrolls/material.ts';
import { SCROLL_WRITING_VERSIONS, scrollPlanItem, type ScrollPlanItem } from '../../packages/core/src/scrolls/writing.ts';
import { assertDisposableDatabaseName } from '../lib/demo-database-guard.ts';
import { countLedgerRequest } from '../lib/session-ledger.ts';

type Gate = WriteScrollDeps['beforeSend'];

/** Before each live request: the transport's quota preflight, then one count in the session ledger. */
export function liveRequestGate(transport: { ready(signal: AbortSignal): Promise<{ ok: true } | { ok: false; reason: string }> }, ledgerPath: string,
  run: { at: string; database: string; kind: string }): { beforeSend: Gate; ledger: () => { used: number; cap: number } | null } {
  let last: { used: number; cap: number } | null = null;
  return {
    async beforeSend(signal) {
      const ready = await transport.ready(signal);
      if (!ready.ok) return ready;
      const counted = await countLedgerRequest(ledgerPath, run);
      if (!counted.ok) return counted;
      last = { used: counted.used, cap: counted.cap };
      return { ok: true };
    },
    ledger: () => last,
  };
}

export interface WriteScrollsReceipt {
  at: string; database: string; transport: 'fixture' | 'minimax'; model: string; apply: boolean;
  versions: Record<string, string>; planSha256: string;
  counts: { planned: number; admitted: number; refused: number; alreadyDecided: number; ready: number; notSent: number; failed: number; notAttempted: number };
  /** The item at which a refusal of the route ended the run. */
  stopped: { index: number; reason: string } | null;
  ledger: { used: number; cap: number } | null;
  items: (ScrollItemResult & { index: number })[];
}

export async function runWriteScrolls(
  options: { database: string; plan: readonly ScrollPlanItem[]; apply: boolean; at: string; signal?: AbortSignal },
  deps: { transport: ScrollTransport; model: string; beforeSend: Gate; ledger?: () => { used: number; cap: number } | null; fetchImpl?: typeof fetch; receiptDir: string },
): Promise<{ receipt: WriteScrollsReceipt; path: string }> {
  // Loaded only now: the database module connects to DATABASE_URL, which the caller has checked.
  const { writeScroll } = await import('../../apps/worker/src/scrolls/write-scroll.ts');
  const items: WriteScrollsReceipt['items'] = [];
  let stopped: WriteScrollsReceipt['stopped'] = null;
  for (const [index, item] of options.plan.entries()) {
    const result = await writeScroll({
      transport: deps.transport, model: deps.model, apply: options.apply, beforeSend: deps.beforeSend,
      signal: options.signal ?? new AbortController().signal, fetchImpl: deps.fetchImpl,
    }, item);
    items.push({ index, ...result });
    if (result.status === 'not_sent' || result.status === 'failed') { stopped = { index, reason: result.reasons[0]! }; break; }
  }
  const count = (status: ScrollItemResult['status']) => items.filter(i => i.status === status).length;
  const receipt: WriteScrollsReceipt = {
    at: options.at, database: options.database, transport: deps.transport.kind, model: deps.model, apply: options.apply,
    versions: { ...SCROLL_WRITING_VERSIONS, hosts: MATERIAL_POLICY_VERSION },
    planSha256: createHash('sha256').update(JSON.stringify(options.plan)).digest('hex'),
    counts: {
      planned: options.plan.length, admitted: count('admitted'), refused: count('refused'), alreadyDecided: count('already_decided'),
      ready: count('ready'), notSent: count('not_sent'), failed: count('failed'), notAttempted: options.plan.length - items.length,
    },
    stopped, ledger: deps.ledger?.() ?? null, items,
  };
  mkdirSync(deps.receiptDir, { recursive: true });
  const path = resolve(deps.receiptDir, `${options.at.replace(/[:.]/g, '-')}-${options.database}.receipt.json`);
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`);
  return { receipt, path };
}

function refuse(message: string): number {
  console.error(`Refusing: ${message}`);
  return 2;
}

const OPTIONS = {
  database: { type: 'string' }, plan: { type: 'string' }, transport: { type: 'string' }, 'fixture-mode': { type: 'string' }, apply: { type: 'boolean' },
} as const;
const readArgs = (argv: string[]) => parseArgs({ args: argv, strict: true, options: OPTIONS }).values;

async function main(argv: string[]): Promise<number> {
  let args: ReturnType<typeof readArgs>;
  try { args = readArgs(argv); } catch (error) { return refuse((error as Error).message); }
  const { database, plan: planPath, transport: kind, 'fixture-mode': fixtureMode = 'scroll', apply = false } = args;
  if (!database || !planPath || (kind !== 'fixture' && kind !== 'minimax')) return refuse('pass --database, --plan and --transport fixture|minimax.');
  try { assertDisposableDatabaseName(database); } catch (error) { return refuse((error as Error).message); }
  let plan: ScrollPlanItem[];
  try { plan = z.array(scrollPlanItem).min(1).parse(JSON.parse(readFileSync(planPath, 'utf8'))); }
  catch { return refuse('the plan must be a JSON array of {"url", "conceptCodes"} with one to eight distinct concept codes each.'); }
  if (!SCROLL_FIXTURE_MODES.includes(fixtureMode as ScrollFixtureMode)) return refuse(`--fixture-mode is one of ${SCROLL_FIXTURE_MODES.join(', ')}.`);

  const at = new Date().toISOString();
  let transport: ScrollTransport;
  let gate: ReturnType<typeof liveRequestGate>;
  if (kind === 'minimax') {
    const apiKey = process.env.MINIMAX_API_KEY ?? '';
    if (!apiKey.startsWith('sk-cp-')) return refuse('--transport minimax needs a MiniMax subscription (sk-cp-) key in MINIMAX_API_KEY.');
    if (!process.env.KS_DEV_ROOT) return refuse('source scripts/env.sh first: the session ledger lives under KS_DEV_ROOT.');
    const live = createMiniMaxAnswerTransport({ apiKey });
    transport = live;
    gate = liveRequestGate(live, resolve(process.env.KS_DEV_ROOT, 'minimax-answer-session-ledger.json'), { at, database, kind: 'scroll' });
  } else {
    transport = createFixtureScrollTransport(() => fixtureMode as ScrollFixtureMode);
    gate = { beforeSend: async () => ({ ok: true }), ledger: () => null };
  }

  const env = Object.fromEntries((existsSync('.env') ? readFileSync('.env', 'utf8') : '').split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  const base = process.env.DATABASE_URL ?? env.DATABASE_URL;
  if (!base || !URL.canParse(base)) return refuse('no DATABASE_URL in the environment or .env.');
  const url = new URL(base);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) return refuse('local PostgreSQL only.');
  url.pathname = `/${database}`;
  process.env.DATABASE_URL = url.toString();

  const stop = new AbortController();
  process.once('SIGINT', () => stop.abort());
  const { pool } = await import('../../packages/db/src/index.ts');
  try {
    const { receipt, path } = await runWriteScrolls({ database, plan, apply, at, signal: stop.signal },
      { transport, model: kind === 'minimax' ? 'MiniMax-M3' : 'fixture-model', beforeSend: gate.beforeSend, ledger: gate.ledger, receiptDir: resolve('artifacts/scroll-writing') });
    console.log(JSON.stringify({ receipt: path, counts: receipt.counts, stopped: receipt.stopped, ledger: receipt.ledger }, null, 2));
    return receipt.stopped ? 1 : 0;
  } finally { await pool.end(); }
}

// pathToFileURL, not string concatenation: the SSD path contains a space (verify-substrate.ts).
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
