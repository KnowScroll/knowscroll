/**
 * #164 — install a Scroll-writing route and its material in a disposable database (ADR-0046 §3).
 *
 *   pnpm exec tsx scripts/scrolls/install-supply.ts --database knowscroll_demo_… --plan plan.json \
 *     --transport fixture|minimax --request-cap N
 *
 * The database must be a disposable `knowscroll_test_*` or `knowscroll_demo_*` database, migrated
 * and seeded; its name is checked before any database module is loaded, and the connection is the
 * local DATABASE_URL (environment, else `.env`) with that name, as for `write-scrolls.ts`. The plan
 * is ADR-0041's: a JSON array of `{"url": "https://…", "conceptCodes": ["…"]}`, allowlisted pages
 * and concepts the substrate holds; one page outside the allowlist installs nothing. Material already
 * installed is kept as it was. The route is enabled (disabling any other) with the request cap as its
 * bucket: `fixture` writes with the labelled fixture transport, `minimax` with MiniMax-M3, and only a
 * worker started with the same KS_SCROLL_TRANSPORT writes anything. Nothing is fetched or sent here.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { scrollPlanItem, type ScrollPlanItem } from '../../packages/core/src/scrolls/writing.ts';
import { localDisposableDatabaseUrl } from '../lib/demo-database-guard.ts';

/** Bench value: the most requests one installed route may hold. */
const MAX_REQUEST_CAP = 150;

const OPTIONS = { database: { type: 'string' }, plan: { type: 'string' }, transport: { type: 'string' }, 'request-cap': { type: 'string' } } as const;
const readArgs = (argv: string[]) => parseArgs({ args: argv, strict: true, options: OPTIONS }).values;

function refuse(message: string): number {
  console.error(`Refusing: ${message}`);
  return 2;
}

async function main(argv: string[]): Promise<number> {
  let args: ReturnType<typeof readArgs>;
  try { args = readArgs(argv); } catch (error) { return refuse((error as Error).message); }
  const { database, plan: planPath, transport, 'request-cap': capText } = args;
  const cap = Number(capText);
  if (!database || !planPath || (transport !== 'fixture' && transport !== 'minimax') || !Number.isInteger(cap) || cap < 1 || cap > MAX_REQUEST_CAP) {
    return refuse(`pass --database, --plan, --transport fixture|minimax and --request-cap 1..${MAX_REQUEST_CAP}.`);
  }
  try { process.env.DATABASE_URL = localDisposableDatabaseUrl(database); } catch (error) { return refuse((error as Error).message); }
  let plan: ScrollPlanItem[];
  try { plan = z.array(scrollPlanItem).min(1).parse(JSON.parse(readFileSync(planPath, 'utf8'))); }
  catch { return refuse('the plan must be a JSON array of {"url", "conceptCodes"} with one to eight distinct concept codes each.'); }

  // Loaded only now: the database module connects to DATABASE_URL, which is checked above.
  const { pool, transaction } = await import('../../packages/db/src/index.ts');
  const { installMaterialCandidates, installScrollWritingRoute } = await import('../../packages/db/src/inventory/supply.ts');
  try {
    const route = { id: `${transport}-route-${Date.now()}`, transport, model: transport === 'minimax' ? 'MiniMax-M3' : 'fixture-model', requestCap: cap } as const;
    const { installed } = await transaction(async client => {
      await installScrollWritingRoute(client, route);
      return installMaterialCandidates(client, plan);
    });
    console.log(JSON.stringify({ route: route.id, transport, requestCap: cap, material: { planned: plan.length, installed } }));
    return 0;
  } catch (error) {
    return refuse((error as Error).message);
  } finally { await pool.end(); }
}

// pathToFileURL, not string concatenation: the SSD path contains a space (verify-substrate.ts).
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
