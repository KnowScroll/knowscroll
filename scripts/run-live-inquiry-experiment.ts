/**
 * #132 — the bounded live background-inquiry experiment (ADR-0038; owner authorization of 2026-09-24).
 *
 * Refuses by default. `--fixture` proves the runner with the labelled fixture transport (no network).
 * `--live` uses MiniMax-M3 through the subscription route only: the `sk-cp-` key is read from the
 * macOS Keychain item `minimax_api_key` straight into the worker process's environment and never
 * printed; the worker's MiniMax transport runs the quota preflight (>=25% interval and weekly) before
 * each request.
 *
 * One inquiry per run by default (`--inquiries N`, 1..3). Each is caused the product's way: the
 * reader has given consent, then the Cartographer forms a place (from supplied, labelled anchored
 * accounts, as in the `inquiry` journey), which mails an inquiry that the worker opens once due.
 * Bounds: the persistent session ledger under $KS_DEV_ROOT (shared with the Ask-answer experiment)
 * caps live requests at 40 for this session, and the route's request-quota bucket is set to what this
 * run may use, so admission itself stops at the limit. Requests stay within 16 KB and 4,096 output
 * tokens. Everything runs against a disposable database that is dropped afterwards. Receipts record
 * statuses, reason codes, counts, usage and hashes only -- never a prompt, a reply, a mechanism or a
 * key. A found bridge's text stays in the disposable database and an ignored local file.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import pg from 'pg';

const mode = process.argv.includes('--live') ? 'live' : process.argv.includes('--fixture') ? 'fixture' : null;
if (!mode) { console.log('Refusing: pass --fixture (no network) or --live (bounded MiniMax-M3 experiment).'); process.exit(2); }
const countArg = process.argv.indexOf('--inquiries');
const INQUIRIES = countArg < 0 ? 1 : Number(process.argv[countArg + 1]);
if (!Number.isInteger(INQUIRIES) || INQUIRIES < 1 || INQUIRIES > 3) { console.log('Refusing: --inquiries takes 1..3'); process.exit(2); }
const SESSION_CAP = 40;
// Each step forms one more place after consent; every step opens a new candidate pair with the
// places before it. The first place is formed before consent, so it mails nothing.
const BEFORE_CONSENT = ['astro.sun'];
const STEPS = [['physics.gravity'], ['earth.tides'], ['astro.star.birth']].slice(0, INQUIRIES);

const root = resolve('.');
const devRoot = process.env.KS_DEV_ROOT ?? (() => { throw new Error('Source scripts/env.sh first'); })();
const ledgerPath = resolve(devRoot, 'minimax-answer-session-ledger.json');
type Ledger = { sessionCap: number; used: number; runs: { at: string; dispatched: number; database: string; kind?: string }[] };
const ledger: Ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : { sessionCap: SESSION_CAP, used: 0, runs: [] };
const allowance = mode === 'live' ? Math.min(INQUIRIES, ledger.sessionCap - ledger.used) : INQUIRIES;
if (allowance < INQUIRIES) { console.log(`Refusing: the session allowance has ${ledger.sessionCap - ledger.used} live requests left; this run needs ${INQUIRIES}.`); process.exit(2); }

const config = Object.fromEntries(readFileSync(resolve(root, '.env'), 'utf8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const source = new URL(config.DATABASE_URL!);
if (!['127.0.0.1', 'localhost'].includes(source.hostname)) throw new Error('Local PostgreSQL only');
const database = `knowscroll_test_live_inquiry_${randomBytes(6).toString('hex')}`;
const url = (db: string) => { const u = new URL(source); u.pathname = `/${db}`; return u.toString(); };
const freePort = () => new Promise<number>((ok, fail) => { const s = createServer(); s.once('error', fail); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => ok(p)); }); });
const children: ChildProcess[] = [];
const run = (cmd: string, args: string[], env: NodeJS.ProcessEnv) => execFileSync(cmd, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  const admin = new pg.Client({ connectionString: url('postgres') });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${database}`);
  const token = randomBytes(32).toString('hex');
  const port = await freePort();
  const base: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, KS_DEV_ROOT: devRoot, TMPDIR: process.env.TMPDIR,
    npm_config_cache: process.env.npm_config_cache, COREPACK_HOME: process.env.COREPACK_HOME, DATABASE_URL: url(database), KS_DEV_TOKEN: token, PORT: String(port), NODE_ENV: 'test' };
  const receipt: Record<string, unknown> = { at: new Date().toISOString(), mode, database, model: mode === 'live' ? 'MiniMax-M3' : 'fixture',
    simulated: 'places formed from supplied anchored accounts (labelled), as in the inquiry journey; consent, mail, admission, the call and the validator are real', inquiries: [] as unknown[] };
  const pool = new pg.Pool({ connectionString: url(database) });
  let closeDb: () => Promise<void> = async () => undefined;
  try {
    run('pnpm', ['db:migrate'], base);
    run('pnpm', ['db:seed'], base);
    // The product's own modules, against the disposable database only.
    process.env.DATABASE_URL = url(database);
    const db = await import('../packages/db/src/index.ts');
    const inquiries = await import('../packages/db/src/reasoning-inquiries.ts');
    const { answerFairnessPolicy } = await import('../packages/db/src/reasoning-answers.ts');
    const { createReasoningFairness } = await import('../packages/db/src/reasoning-fairness.ts');
    const { runCartographer } = await import('../packages/db/src/atlas.ts');
    const v = 'live-inquiries-v1';
    await createReasoningFairness(db.pool, inquiries.inquiryAuthority()).installPolicy(answerFairnessPolicy(v, { maxInputTokens: 16384, maxOutputTokens: 4096 }));
    await db.transaction(c => inquiries.installBackgroundInquiryRoute(c, { policyVersion: v,
      routeId: mode === 'live' ? 'minimax-subscription' : 'fixture-route', routeProfileVersion: mode === 'live' ? 'minimax-m3-anthropic-v1' : 'fixture-v1',
      transport: mode === 'live' ? 'minimax' : 'fixture', model: mode === 'live' ? 'MiniMax-M3' : 'fixture-model', maxInputTokens: 16384, maxOutputTokens: 4096,
      requestCap: allowance, tokenBudget: allowance * 24000, ownerCapacity: allowance * 24000, jobCapacity: 24000,
      coalescingDelaySeconds: 1, jobTtlSeconds: 600, remoteSlots: 1 }));
    closeDb = () => db.pool.end();

    const workerEnv: NodeJS.ProcessEnv = { ...base, KS_INQUIRY_TRANSPORT: mode === 'live' ? 'minimax' : 'fixture', KS_INQUIRY_FIXTURE_MODE: 'proposal' };
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
    for (let i = 0; i < 100; i += 1) { try { if ((await fetch(`${api}/health`)).ok) break; } catch { /* starting */ } await sleep(200); }
    const identity = await db.provisionIdentity();
    const h = { authorization: `Bearer ${identity.token}`, 'content-type': 'application/json' };
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await fetch(`${api}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => null) as Record<string, unknown> | null };
    };
    const anchored = (concept: string) => ({ concept, state: 'anchored' as const, episodes: 3, daysActive: 2, voluntary: 2, sourceFamilies: 2, mass: 1, evidence: { episodeIds: [], markIds: [] } });
    const formed: string[] = [];
    const form = async (codes: string[]) => {
      formed.push(...codes);
      await db.transaction(async c => {
        await c.query('SELECT id FROM universe WHERE id=$1 FOR UPDATE', [identity.scope.universeId]);
        await runCartographer(c, identity.scope.universeId, formed.map(anchored));
      });
    };

    await form(BEFORE_CONSENT);
    const consent = await call('PUT', '/v1/inquiries/consent', { enabled: true, dailyLimit: Math.max(3, INQUIRIES), clientRequestId: randomUUID(), expectedPrivacyEpoch: 0 });
    receipt.consent = { status: consent.status, available: (consent.body?.consent as Record<string, unknown> | undefined)?.available ?? null };
    if (consent.status !== 200) throw new Error(`Consent was refused (${consent.status})`);

    for (const [index, step] of STEPS.entries()) {
      await form(step);
      let view: Record<string, unknown> | undefined;
      for (let i = 0; i < 600; i += 1) {
        const list = await call('GET', '/v1/inquiries');
        view = ((list.body?.inquiries ?? []) as Record<string, unknown>[])[0];
        if (view && !['waiting', 'looking'].includes(String(view.status)) && (receipt.inquiries as unknown[]).length === index) break;
        await sleep(500);
      }
      const row = view ? (await pool.query(
        `SELECT i.request_hash, i.input_bytes, ac.state AS accounting, rr.http_status, json_build_object('input', rr.input_tokens, 'output', rr.output_tokens) AS usage
         FROM background_inquiry i LEFT JOIN reasoning_attempt at ON at.job_id = i.job_id
         LEFT JOIN reasoning_accounting ac ON ac.attempt_id = at.id LEFT JOIN reasoning_receipt rr ON rr.attempt_id = at.id WHERE i.id = $1`, [view.inquiryId])).rows[0] : null;
      const found = (view?.found ?? null) as Record<string, unknown> | null;
      let continuation: number | null = null;
      if (found) {
        // The admitted personal bridge is a continuation where either side is read.
        const bridgeId = String(found.bridgeId);
        const assets = (await pool.query<{ asset_id: string }>(
          `SELECT ac.asset_id FROM asset_concept ac JOIN concept c ON c.id = ac.concept_id JOIN bridge b ON b.id = $1
           WHERE ac.concept_id IN (b.from_concept_id, b.to_concept_id) AND ac.role = 'primary' LIMIT 3`, [bridgeId])).rows;
        continuation = 0;
        for (const a of assets) {
          const branches = await call('GET', `/v1/assets/${a.asset_id}/branches`);
          if (JSON.stringify(branches.body ?? {}).includes(bridgeId)) continuation += 1;
        }
        mkdirSync(resolve(root, 'artifacts/live-inquiries'), { recursive: true });
        writeFileSync(resolve(root, `artifacts/live-inquiries/${database}-${index + 1}.local.json`), JSON.stringify(view, null, 2));
      }
      (receipt.inquiries as unknown[]).push({
        step: index + 1, placeFormed: step, status: view?.status ?? null, reasons: view?.reasons ?? [],
        pairs: Array.isArray(view?.pairs) ? (view!.pairs as unknown[]).length : 0,
        found: found ? { relationType: found.relationType, evidence: Array.isArray(found.evidence) ? (found.evidence as unknown[]).length : 0,
          sentenceSha256: sha(found.sentence), bridgeStatus: found.bridgeStatus, continuationsShowingIt: continuation } : null,
        requestSha256: row?.request_hash ?? null, inputBytes: row?.input_bytes ?? null,
        accounting: row?.accounting ?? null, httpStatus: row?.http_status ?? null, usage: row?.usage ?? null,
      });
    }
    receipt.proposals = (await pool.query(`SELECT status, count(*)::int AS n FROM semantic_proposal WHERE proposer_kind = 'model' GROUP BY status ORDER BY status`)).rows;
    // For diagnosis, locally only (ignored artifacts, never Git): each model proposal's structure --
    // relation, direction, cited claim keys with what they support and each claim's concept roles --
    // and the validator's decision. The mechanism and other prose are left out even here.
    const structure = (await pool.query(`SELECT p.status, p.decision, p.payload->>'relationType' AS relation, p.payload->>'fromConcept' AS "from",
        p.payload->>'toConcept' AS "to", p.payload->'evidence' AS evidence, p.payload->'counterevidence'->'claimKeys' AS counter
      FROM semantic_proposal p WHERE p.proposer_kind = 'model'`)).rows;
    const roles = (await pool.query(`SELECT cl.key, json_agg(json_build_object('code', c.code, 'role', cc.role)) AS links
      FROM claim cl JOIN claim_concept cc ON cc.claim_id = cl.id JOIN concept c ON c.id = cc.concept_id GROUP BY cl.key`)).rows;
    const cited = new Set(structure.flatMap(r => (r.evidence ?? []).map((e: { claimKey: string }) => e.claimKey)));
    mkdirSync(resolve(root, 'artifacts/live-inquiries'), { recursive: true });
    writeFileSync(resolve(root, `artifacts/live-inquiries/${database}.structure.local.json`),
      JSON.stringify({ proposals: structure, claimRoles: roles.filter(r => cited.has(r.key)) }, null, 2));
  } finally {
    // Workers stop first, so nothing can dispatch after the count; the count is written to the
    // session ledger whether or not the run succeeded, and the database is kept if it cannot be.
    for (const c of children) { try { process.kill(-c.pid!, 'SIGTERM'); } catch { /* gone */ } }
    await sleep(1500);
    for (const c of children) { try { process.kill(-c.pid!, 'SIGKILL'); } catch { /* gone */ } }
    let counted = mode !== 'live';
    try {
      const dispatched = Number((await pool.query('SELECT count(*) FROM reasoning_accounting WHERE dispatch_id IS NOT NULL')).rows[0].count);
      receipt.dispatched = dispatched;
      if (mode === 'live') {
        ledger.used += dispatched;
        ledger.runs.push({ at: String(receipt.at), dispatched, database, kind: 'inquiry' });
        writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
        receipt.sessionLedger = { used: ledger.used, cap: ledger.sessionCap };
        counted = true;
      }
    } catch { console.error(`Live requests could not be counted; ${database} is kept for counting by hand.`); }
    await pool.end().catch(() => undefined);
    await closeDb().catch(() => undefined);
    if (counted) await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`).catch(() => undefined);
    await admin.end();
  }
  mkdirSync(resolve(root, 'artifacts/live-inquiries'), { recursive: true });
  const out = resolve(root, `artifacts/live-inquiries/${database}.receipt.json`);
  writeFileSync(out, JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt, null, 2));
}

await main();
