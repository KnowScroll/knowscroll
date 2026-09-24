/**
 * #132 — the bounded live Ask-answer experiment (ADR-0033; owner authorization of 2026-09-24).
 *
 * Refuses by default. `--fixture` proves the runner with the labelled fixture transport (no network).
 * `--live` uses MiniMax-M3 through the subscription route only: the `sk-cp-` key is read from the
 * macOS Keychain item `minimax_api_key` straight into the worker process's environment and never
 * printed; the worker runs the quota preflight (>=25% interval and weekly) before each request.
 *
 * Bounds: a persistent session ledger under $KS_DEV_ROOT caps live requests at 40 for this session;
 * the route's request-quota bucket is set to the remaining allowance, so admission itself stops a run
 * at its limit. Requests stay within 16 KB and 1,024 output tokens. Everything runs against a
 * disposable database that is dropped afterwards. Receipts record statuses, counts, usage and
 * hashes only — never a question, answer, quote or key.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import pg from 'pg';

const mode = process.argv.includes('--live') ? 'live' : process.argv.includes('--fixture') ? 'fixture' : null;
if (!mode) { console.log('Refusing: pass --fixture (no network) or --live (bounded MiniMax-M3 experiment).'); process.exit(2); }
const SESSION_CAP = 40;
const TARGET = '20000000-0000-4000-8000-000000000004'; // "A rhythm the ocean keeps"
const PAIR = [
  { label: 'answerable', text: 'Why do most coasts get two high tides a day instead of one?' },
  { label: 'not_in_source', text: 'Who was the first person to measure tides scientifically?' },
];
// `--sample N` repeats the Android journey's question N times (1..8) to measure how often a live
// reply survives the validator; the default is the answerable / not-in-source pair.
const sampleArg = process.argv.indexOf('--sample');
const sample = sampleArg < 0 ? 0 : Number(process.argv[sampleArg + 1]);
if (sampleArg >= 0 && (!Number.isInteger(sample) || sample < 1 || sample > 8)) { console.log('Refusing: --sample takes 1..8'); process.exit(2); }
const QUESTIONS = sample > 0
  ? Array.from({ length: sample }, (_, i) => ({ label: `android-question-${i + 1}`, text: 'Does this Scroll say anything about tides?' }))
  : PAIR;

const root = resolve('.');
const devRoot = process.env.KS_DEV_ROOT ?? (() => { throw new Error('Source scripts/env.sh first'); })();
const ledgerPath = resolve(devRoot, 'minimax-answer-session-ledger.json');
type Ledger = { sessionCap: number; used: number; runs: { at: string; dispatched: number; database: string }[] };
const ledger: Ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : { sessionCap: SESSION_CAP, used: 0, runs: [] };
const allowance = mode === 'live' ? Math.min(QUESTIONS.length, ledger.sessionCap - ledger.used) : QUESTIONS.length;
if (allowance < QUESTIONS.length) { console.log(`Refusing: the session allowance has ${ledger.sessionCap - ledger.used} live requests left; this run needs ${QUESTIONS.length}.`); process.exit(2); }

const config = Object.fromEntries(readFileSync(resolve(root, '.env'), 'utf8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const source = new URL(config.DATABASE_URL!);
if (!['127.0.0.1', 'localhost'].includes(source.hostname)) throw new Error('Local PostgreSQL only');
const database = `knowscroll_test_live_answer_${randomBytes(6).toString('hex')}`;
const url = (db: string) => { const u = new URL(source); u.pathname = `/${db}`; return u.toString(); };
const freePort = () => new Promise<number>((ok, fail) => { const s = createServer(); s.once('error', fail); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => ok(p)); }); });
const children: ChildProcess[] = [];
const run = (cmd: string, args: string[], env: NodeJS.ProcessEnv) => execFileSync(cmd, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });

async function main() {
  const admin = new pg.Client({ connectionString: url('postgres') });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${database}`);
  const token = randomBytes(32).toString('hex');
  const port = await freePort();
  const base: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, KS_DEV_ROOT: devRoot, TMPDIR: process.env.TMPDIR,
    npm_config_cache: process.env.npm_config_cache, COREPACK_HOME: process.env.COREPACK_HOME, DATABASE_URL: url(database), KS_DEV_TOKEN: token, PORT: String(port), NODE_ENV: 'test' };
  const receipt: Record<string, unknown> = { at: new Date().toISOString(), mode, database, model: mode === 'live' ? 'MiniMax-M3' : 'fixture', asks: [] as unknown[] };
  const pool = new pg.Pool({ connectionString: url(database) });
  let closeDb: () => Promise<void> = async () => undefined;
  try {
    run('pnpm', ['db:migrate'], base);
    run('pnpm', ['db:seed'], base);
    // The product's own modules, against the disposable database only.
    process.env.DATABASE_URL = url(database);
    const db = await import('../packages/db/src/index.ts');
    const answers = await import('../packages/db/src/reasoning-answers.ts');
    const { createReasoningFairness } = await import('../packages/db/src/reasoning-fairness.ts');
    const v = 'live-answers-v1';
    await createReasoningFairness(db.pool, answers.answerAuthority()).installPolicy(answers.answerFairnessPolicy(v, { maxInputTokens: 16384, maxOutputTokens: 1024 }));
    await db.transaction(c => answers.installAskAnswerRoute(c, { policyVersion: v,
      routeId: mode === 'live' ? 'minimax-subscription' : 'fixture-route', routeProfileVersion: mode === 'live' ? 'minimax-m3-anthropic-v1' : 'fixture-v1',
      transport: mode === 'live' ? 'minimax' : 'fixture', model: mode === 'live' ? 'MiniMax-M3' : 'fixture-model', maxInputTokens: 16384, maxOutputTokens: 1024,
      requestCap: allowance, tokenBudget: allowance * 20000, ownerCapacity: allowance * 20000, jobCapacity: 20000, answerTtlSeconds: 300, remoteSlots: 1 }));
    closeDb = () => db.pool.end();

    const workerEnv: NodeJS.ProcessEnv = { ...base, KS_ANSWER_TRANSPORT: mode === 'live' ? 'minimax' : 'fixture' };
    if (mode === 'live') {
      const key = execFileSync('security', ['find-generic-password', '-s', 'minimax_api_key', '-w'], { encoding: 'utf8' }).trim();
      if (!key.startsWith('sk-cp-')) throw new Error('Refusing: the Keychain key is not a subscription (sk-cp-) key');
      workerEnv.MINIMAX_API_KEY = key;
    }
    for (const [role, env] of [['api', base], ['worker', workerEnv]] as const) {
      const child = spawn('pnpm', ['exec', 'tsx', `apps/${role}/src/main.ts`], { env, stdio: 'ignore', detached: true });
      children.push(child);
    }
    const api = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100; i += 1) { try { if ((await fetch(`${api}/health`)).ok) break; } catch { /* starting */ } await new Promise(r => setTimeout(r, 200)); }
    const identity = await db.provisionIdentity();
    const h = { authorization: `Bearer ${identity.token}`, 'content-type': 'application/json' };
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await fetch(`${api}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => null) as Record<string, unknown> | null };
    };

    // Reach the target Scroll through the real feed, exposing what is served on the way.
    let exposureId: string | null = null;
    for (let step = 0; step < 30 && !exposureId; step += 1) {
      const feed = await call('GET', '/v1/feed?kinds=Scroll');
      const items = (feed.body?.items ?? []) as { assetId: string }[];
      const pick = items.find(i => i.assetId === TARGET) ?? items[0];
      if (!pick) throw new Error('The feed ran out before the target Scroll');
      const exposed = await call('POST', '/v1/exposures', { decisionId: feed.body!.decisionId, assetId: pick.assetId, clientExposureId: randomUUID() });
      if (pick.assetId === TARGET) exposureId = exposed.body!.exposureId as string;
      else await call('POST', '/v1/interactions', { clientEventId: randomUUID(), exposureId: exposed.body!.exposureId, assetId: pick.assetId, kind: 'keep' });
    }
    if (!exposureId) throw new Error('The target Scroll was not reached');

    for (const q of QUESTIONS) {
      const asked = await call('POST', '/v1/asks', { clientAskId: randomUUID(), exposureId, expectedPrivacyEpoch: 0, question: q.text });
      const askId = asked.body!.askId as string;
      const requested = await call('POST', `/v1/asks/${askId}/answer`, { clientRequestId: randomUUID(), expectedPrivacyEpoch: 0 });
      let view: Record<string, unknown> | null = null;
      for (let i = 0; i < 300; i += 1) {
        view = (await call('GET', `/v1/asks/${askId}/answer`)).body;
        if (view && !['queued', 'running'].includes(String(view.status))) break;
        await new Promise(r => setTimeout(r, 300));
      }
      const usage = (await pool.query(`SELECT ac.state, rr.http_status, json_build_object('input', rr.input_tokens, 'output', rr.output_tokens) AS usage FROM ask_answer_request r JOIN reasoning_attempt at ON at.job_id=r.job_id
        JOIN reasoning_accounting ac ON ac.attempt_id=at.id LEFT JOIN reasoning_receipt rr ON rr.attempt_id=at.id WHERE r.ask_id=$1`, [askId])).rows[0] ?? null;
      (receipt.asks as unknown[]).push({
        label: q.label, requestStatus: requested.status, status: view?.status ?? null, reasons: view?.reasons ?? [],
        basisQuotes: Array.isArray(view?.basis) ? (view!.basis as unknown[]).length : 0, answerChars: typeof view?.answer === 'string' ? (view!.answer as string).length : 0,
        answerSha256: typeof view?.answer === 'string' ? createHash('sha256').update(view!.answer as string).digest('hex') : null,
        accountingState: usage?.state ?? null, httpStatus: usage?.http_status ?? null, usage: usage?.usage ?? null,
      });
      // The live answer text stays only in the disposable database and the ignored local view below.
      if (view && typeof view.answer === 'string') {
        mkdirSync(resolve(root, 'artifacts/live-answers'), { recursive: true });
        writeFileSync(resolve(root, `artifacts/live-answers/${database}-${q.label}.local.json`), JSON.stringify({ question: q.text, ...view }, null, 2));
      }
    }
    const dispatched = Number((await pool.query('SELECT count(*) FROM reasoning_accounting WHERE dispatch_id IS NOT NULL')).rows[0].count);
    receipt.dispatched = dispatched;
    if (mode === 'live') {
      ledger.used += dispatched;
      ledger.runs.push({ at: String(receipt.at), dispatched, database });
      writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
      receipt.sessionLedger = { used: ledger.used, cap: ledger.sessionCap };
    }
  } finally {
    for (const c of children) { try { process.kill(-c.pid!, 'SIGTERM'); } catch { /* gone */ } }
    await new Promise(r => setTimeout(r, 1500));
    for (const c of children) { try { process.kill(-c.pid!, 'SIGKILL'); } catch { /* gone */ } }
    await pool.end().catch(() => undefined);
    await closeDb().catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`).catch(() => undefined);
    await admin.end();
  }
  mkdirSync(resolve(root, 'artifacts/live-answers'), { recursive: true });
  const out = resolve(root, `artifacts/live-answers/${database}.receipt.json`);
  writeFileSync(out, JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt, null, 2));
}

await main();
