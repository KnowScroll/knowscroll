/**
 * #162 — the operator CLI for model-written Scrolls (ADR-0041 §8). As a subprocess: it refuses a
 * database that is not disposable and a key that is not a subscription key before it connects to
 * anything. In process, with the real MiniMax transport over a mocked network (no key, no provider):
 * each request is preceded by the quota preflight and counted in the session ledger under its lock;
 * the run stops at the first refusal of the route; and the receipt holds counts, statuses, hashes
 * and usage, never a prompt, a reply or a key. Page text and replies are hand-written fixtures.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { createMiniMaxAnswerTransport, MINIMAX_ANSWER_URL } from '../apps/worker/src/providers/minimax-answer.ts';
import { MINIMAX_QUOTA_URL } from '../apps/worker/src/providers/minimax-quota.ts';
import { pool, transaction } from '../packages/db/src/index.ts';
import { loadSubstrateSeed } from '../packages/db/src/semantic/seed.ts';
import { countLedgerRequest } from '../scripts/lib/session-ledger.ts';
import { liveRequestGate, runWriteScrolls } from '../scripts/scrolls/write-scrolls.ts';
import { makeSemanticFixture } from './helpers/semantic-fixture.ts';

const database = new URL(process.env.DATABASE_URL!).pathname.slice(1);
if (!database.startsWith('knowscroll_test_')) throw new Error('CLI tests require an isolated knowscroll_test_* database');
after(async () => { await pool.end(); });

const run = promisify(execFile);
const KEY = `sk-cp-${'k'.repeat(24)}`;
// TEST-NET-1 never answers: a refusal that came after a connection attempt would hang, not exit.
const unroutable = (name: string) => `postgresql://u:p@192.0.2.1:5432/${name}`;
async function cli(args: string[], env: Record<string, string>) {
  try {
    const { stdout, stderr } = await run('pnpm', ['exec', 'tsx', 'scripts/scrolls/write-scrolls.ts', ...args], { env: { ...process.env, ...env }, timeout: 20_000 });
    return { code: 0, out: stdout + stderr };
  } catch (error) {
    const e = error as { code: number; stdout: string; stderr: string };
    return { code: e.code, out: e.stdout + e.stderr };
  }
}

test('the CLI refuses a database that is not disposable, and a key that is not a subscription key, before connecting', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ks-scroll-plan-'));
  const plan = join(dir, 'plan.json');
  writeFileSync(plan, JSON.stringify([{ url: 'https://science.nasa.gov/sun/facts/', conceptCodes: ['astro.sun'] }]));
  for (const name of ['knowscroll', 'knowscroll_demo', 'postgres', 'knowscroll_test_x;drop']) {
    const r = await cli(['--database', name, '--plan', plan, '--transport', 'fixture'], { DATABASE_URL: unroutable('knowscroll') });
    assert.equal(r.code, 2, `${name}: ${r.out}`);
    assert.match(r.out, /Refusing/);
  }
  const key = await cli(['--database', 'knowscroll_test_cli', '--plan', plan, '--transport', 'minimax', '--apply'], { DATABASE_URL: unroutable('knowscroll'), MINIMAX_API_KEY: 'sk-api-paygo-secret' });
  assert.equal(key.code, 2, key.out);
  assert.match(key.out, /subscription \(sk-cp-\) key/);
  assert.ok(!key.out.includes('sk-api-paygo-secret'), 'the key is never printed');
});

test('the session ledger counts one request at a time under its lock, and refuses at the cap', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ks-ledger-'));
  const path = join(dir, 'ledger.json');
  const at = new Date().toISOString();
  assert.deepEqual(await countLedgerRequest(path, { at, database, kind: 'scroll' }), { ok: false, reason: 'ledger_missing' });
  writeFileSync(path, JSON.stringify({ sessionCap: 3, used: 1, runs: [{ at: 'earlier', dispatched: 1, database: 'x', kind: 'inquiry' }], note: 'kept' }));
  const counts = await Promise.all([1, 2, 3].map(() => countLedgerRequest(path, { at, database, kind: 'scroll' })));
  assert.deepEqual(counts.filter(c => c.ok).length, 2, 'two concurrent counts fit, the third is refused');
  assert.ok(counts.some(c => !c.ok && c.reason === 'session_cap_reached'));
  const ledger = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual([ledger.used, ledger.runs.at(-1), ledger.note], [3, { at, database, kind: 'scroll', dispatched: 2 }, 'kept']);
  assert.equal(existsSync(`${path}.lock`), false);
  writeFileSync(`${path}.lock`, '');
  assert.deepEqual(await countLedgerRequest(path, { at, database, kind: 'scroll' }, { lockWaitMs: 100 }), { ok: false, reason: 'ledger_locked' });
});

// A hand-written page and a hand-written provider reply that the checks admit.
const TEXT = 'Fixture material, written by hand for tests. The Moon pulls on the whole Earth, but it pulls hardest on the side that faces it. '
  + 'Water on that side is drawn into a bulge, and a second bulge forms on the far side, where the pull is weakest. '
  + 'As Earth turns, a coast passes through both bulges, so many shores see two high tides and two low tides every day. '
  + 'When the Sun and the Moon line up, their pulls add together and the tides grow larger; these are called spring tides.';
const page = (n: number) => `<html><head><title>Fixture page ${n}</title></head><body><main><p>${TEXT} Page ${n}.</p></main></body></html>`;
const REPLY_TITLE = 'Two bulges, one turning planet';
const reply = (codes: { tides: string; gravity: string }) => JSON.stringify({
  title: REPLY_TITLE,
  summary: 'Why most coasts get two high tides a day, not one.',
  beats: [
    'Picture the ocean as a loose coat around Earth. The Moon tugs on everything, yet it tugs a little harder on whatever sits closest.',
    'That uneven tug stretches the coat into two swellings: one toward the Moon and one on the opposite face.',
    'Earth spins beneath both swellings, so a harbour rides up and down twice as the day goes by.',
  ],
  concepts: [{ code: codes.tides, role: 'primary' }, { code: codes.gravity, role: 'secondary' }],
  claims: [
    { statement: 'The Moon pulls hardest on the side of Earth that faces it.', truthState: 'documented', concepts: [{ code: codes.tides, role: 'subject' }],
      quote: 'it pulls hardest on the side that faces it', supportKind: 'supports' },
    { statement: 'Many coasts have two high tides and two low tides each day.', truthState: 'documented', concepts: [{ code: codes.tides, role: 'subject' }],
      quote: 'many shores see two high tides and two low tides every day', supportKind: 'supports' },
  ],
});

async function liveRun(options: { ledger: object | null; quota?: [number, number]; providerStatus?: number; pages?: number }) {
  const f = await makeSemanticFixture(pool);
  await transaction(c => loadSubstrateSeed(c, f.raw));
  const dir = mkdtempSync(join(tmpdir(), 'ks-scroll-run-'));
  const ledgerPath = join(dir, 'ledger.json');
  if (options.ledger) writeFileSync(ledgerPath, JSON.stringify(options.ledger));
  const url = (n: number) => `https://science.nasa.gov/fixture/${f.tag}/page-${n}/`;
  const sent: string[] = [];
  const [interval, weekly] = options.quota ?? [80, 70];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const at = String(input);
    if (at === MINIMAX_QUOTA_URL) {
      return Response.json({ base_resp: { status_code: 0 }, model_remains: [{ model_name: 'general', current_interval_remaining_percent: interval, current_weekly_remaining_percent: weekly }] });
    }
    if (at === MINIMAX_ANSWER_URL) {
      sent.push(new TextDecoder().decode(init!.body as Buffer));
      if (options.providerStatus) return Response.json({ error: 'fixture' }, { status: options.providerStatus });
      return Response.json({ content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: reply(f.codes) }], usage: { input_tokens: 3100, output_tokens: 420 } });
    }
    const n = Number(/page-(\d+)\/$/.exec(at)?.[1]);
    return new Response(page(n), { status: 200, headers: { 'content-type': 'text/html' } });
  }) as typeof fetch;
  const transport = createMiniMaxAnswerTransport({ apiKey: KEY, fetchImpl });
  const at = new Date().toISOString();
  const gate = liveRequestGate(transport, ledgerPath, { at, database, kind: 'scroll' });
  const plan = Array.from({ length: options.pages ?? 2 }, (_, i) => ({ url: url(i + 1), conceptCodes: [f.codes.tides, f.codes.gravity] }));
  const outcome = await runWriteScrolls({ database, plan, apply: true, at }, { transport, model: 'MiniMax-M3', beforeSend: gate.beforeSend, ledger: gate.ledger, fetchImpl, receiptDir: dir });
  return { ...outcome, sent, ledgerPath, text: readFileSync(outcome.path, 'utf8') };
}

test('a live run: preflight and a counted ledger entry before each request, a receipt without text or key', async () => {
  const r = await liveRun({ ledger: { sessionCap: 155, used: 40, runs: [] } });
  assert.deepEqual(r.receipt.items.map(i => i.status), ['admitted', 'admitted']);
  assert.equal(r.sent.length, 2);
  const ledger = JSON.parse(readFileSync(r.ledgerPath, 'utf8'));
  assert.equal(ledger.used, 42);
  assert.deepEqual(ledger.runs, [{ at: r.receipt.at, database, kind: 'scroll', dispatched: 2 }]);
  assert.deepEqual(r.receipt.counts, { planned: 2, admitted: 2, refused: 0, alreadyDecided: 0, ready: 0, notSent: 0, failed: 0, notAttempted: 0 });
  assert.deepEqual(r.receipt.ledger, { used: 42, cap: 155 });
  assert.equal(r.receipt.stopped, null);
  assert.deepEqual(r.receipt.items[0]!.usage, { inputTokens: 3100, outputTokens: 420, cacheReadTokens: null, cacheWriteTokens: null, costMicroUsd: null });
  assert.ok(r.receipt.items.every(i => /^[0-9a-f]{64}$/.test(i.requestSha256 ?? '') && i.inputBytes! <= 16_384));
  for (const secret of [KEY, REPLY_TITLE, 'Moon', 'Picture the ocean', 'thinking', 'hidden']) assert.ok(!r.text.includes(secret), `the receipt carries ${secret}`);
});

test('the run stops at the first refusal of the route', async () => {
  const noLedger = await liveRun({ ledger: null });
  assert.deepEqual([noLedger.receipt.stopped, noLedger.sent.length], [{ index: 0, reason: 'ledger_missing' }, 0]);
  assert.equal(noLedger.receipt.counts.notAttempted, 1);

  const cap = await liveRun({ ledger: { sessionCap: 40, used: 40, runs: [] } });
  assert.deepEqual([cap.receipt.stopped, cap.sent.length], [{ index: 0, reason: 'session_cap_reached' }, 0]);

  const lowQuota = await liveRun({ ledger: { sessionCap: 155, used: 0, runs: [] }, quota: [24, 90] });
  assert.deepEqual([lowQuota.receipt.stopped, lowQuota.sent.length], [{ index: 0, reason: 'provider_quota_preflight_failed' }, 0]);
  assert.equal(JSON.parse(readFileSync(lowQuota.ledgerPath, 'utf8')).used, 0, 'nothing sent, nothing counted');

  const provider = await liveRun({ ledger: { sessionCap: 155, used: 0, runs: [] }, providerStatus: 500, pages: 3 });
  assert.deepEqual([provider.receipt.stopped, provider.sent.length], [{ index: 0, reason: 'provider_error' }, 1], 'never retried, nothing after it');
  assert.deepEqual([provider.receipt.counts.failed, provider.receipt.counts.notAttempted], [1, 2]);
  assert.equal(JSON.parse(readFileSync(provider.ledgerPath, 'utf8')).used, 1, 'a sent request counts whatever came back');
});
