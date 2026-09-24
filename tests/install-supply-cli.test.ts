/**
 * #164 — the operator script that installs a Scroll-writing route and its material (ADR-0046 §3). As
 * a subprocess: it refuses a database that is not disposable before it connects to anything, and a
 * plan with a page outside the allowlist installs nothing. Against this disposable database: the
 * route is enabled with the request cap as its bucket, the one before it is disabled, and material
 * already installed is kept. Nothing is fetched or sent. Every URL here is a fixture.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { pool } from '../packages/db/src/index.ts';
import { makeInventoryFixture } from './helpers/inventory-fixture.ts';

const database = new URL(process.env.DATABASE_URL!).pathname.slice(1);
if (!database.startsWith('knowscroll_test_')) throw new Error('CLI tests require an isolated knowscroll_test_* database');
// The writing route is deployment-wide: leave none of this file's enabled for the files after it.
after(async () => { await pool.query('UPDATE scroll_writing_route SET enabled=false WHERE enabled'); await pool.end(); });

const run = promisify(execFile);
// TEST-NET-1 never answers: a refusal that came after a connection attempt would hang, not exit.
const unroutable = (name: string) => `postgresql://u:p@192.0.2.1:5432/${name}`;
async function cli(args: string[], env: Record<string, string> = {}) {
  try {
    const { stdout, stderr } = await run('pnpm', ['exec', 'tsx', 'scripts/scrolls/install-supply.ts', ...args], { env: { ...process.env, ...env }, timeout: 20_000 });
    return { code: 0, out: stdout + stderr };
  } catch (error) {
    const e = error as { code: number; stdout: string; stderr: string };
    return { code: e.code, out: e.stdout + e.stderr };
  }
}
function planFile(items: { url: string; conceptCodes: string[] }[]): string {
  const path = join(mkdtempSync(join(tmpdir(), 'ks-supply-plan-')), 'plan.json');
  writeFileSync(path, JSON.stringify(items));
  return path;
}

test('the script refuses a database that is not disposable before connecting', async () => {
  const plan = planFile([{ url: 'https://science.nasa.gov/sun/facts/', conceptCodes: ['astro.sun'] }]);
  for (const name of ['knowscroll', 'knowscroll_demo', 'postgres', 'knowscroll_test_x;drop']) {
    const r = await cli(['--database', name, '--plan', plan, '--transport', 'fixture', '--request-cap', '2'], { DATABASE_URL: unroutable('knowscroll') });
    assert.equal(r.code, 2, `${name}: ${r.out}`);
    assert.match(r.out, /Refusing/);
  }
  const noCap = await cli(['--database', 'knowscroll_test_cli', '--plan', plan, '--transport', 'fixture'], { DATABASE_URL: unroutable('knowscroll') });
  assert.equal(noCap.code, 2, noCap.out);
});

test('it installs and enables a route with its request cap and allowlisted material, replacing the route before it', async () => {
  const f = await makeInventoryFixture();
  const enabled = async () => (await pool.query<{ id: string; transport: string; model: string; capacity: number; reserved: number; consumed: number }>(
    `SELECT r.id, r.transport, r.model, b.capacity::int, b.reserved::int, b.consumed::int FROM scroll_writing_route r
     JOIN reasoning_bucket b ON b.id = r.request_bucket_id WHERE r.enabled`)).rows;
  const installed = async () => (await pool.query<{ url: string; concept_codes: string[] }>(
    'SELECT url, concept_codes FROM scroll_material_candidate WHERE url LIKE $1 ORDER BY url', [`%/${f.tag}/%`])).rows;

  // A page outside the allowlist refuses the whole plan: nothing is installed.
  const refused = await cli(['--database', database, '--plan', planFile([
    { url: f.material('a'), conceptCodes: [f.codes.tides] }, { url: `https://openstax.org/${f.tag}/tides`, conceptCodes: [f.codes.tides] },
  ]), '--transport', 'fixture', '--request-cap', '2']);
  assert.equal(refused.code, 2, refused.out);
  assert.deepEqual(await installed(), []);

  const first = await cli(['--database', database, '--plan', planFile([{ url: f.material('a'), conceptCodes: [f.codes.tides] }]), '--transport', 'fixture', '--request-cap', '2']);
  assert.equal(first.code, 0, first.out);
  const [route] = await enabled();
  assert.deepEqual({ ...route, id: undefined }, { id: undefined, transport: 'fixture', model: 'fixture-model', capacity: 2, reserved: 0, consumed: 0 });
  assert.deepEqual(JSON.parse(first.out.slice(first.out.indexOf('{'))), { route: route!.id, transport: 'fixture', requestCap: 2, material: { planned: 1, installed: 1 } });

  const second = await cli(['--database', database, '--plan', planFile([
    { url: f.material('a'), conceptCodes: [f.codes.gravity] }, { url: f.material('b'), conceptCodes: [f.codes.tides, f.codes.gravity] },
  ]), '--transport', 'minimax', '--request-cap', '1']);
  assert.equal(second.code, 0, second.out);
  const now = await enabled();
  assert.deepEqual(now.map(r => [r.transport, r.model, r.capacity]), [['minimax', 'MiniMax-M3', 1]], 'one enabled route: the new one');
  assert.notEqual(now[0]!.id, route!.id);
  assert.deepEqual(await installed(), [
    { url: f.material('a'), concept_codes: [f.codes.tides] },
    { url: f.material('b'), concept_codes: [f.codes.tides, f.codes.gravity] },
  ], 'installed material is kept as it was');
});
