#!/usr/bin/env node
// Checks the library plan's research pages against the product's own fetcher.
//
// For every recipe it fetches each page through `fetchResearchPage` (the same allowlist, redirect and
// size rules the worker uses) and builds the recipe's quote-candidate pool, the passages the claims
// role chooses from. A recipe passes when every page is accepted and its pool holds 6 to 30 candidates.
// The limit the pool builder enforces is 32; the margin keeps a page that gains a paragraph usable.
//
// Needs the built backend (`pnpm build`) and network access. Pages are fetched one at a time with a
// pause between requests, because Wikipedia answers bursts with rate-limit errors.
//
//   node scripts/check-library-sources.mjs [--only seasons,tides] [--delay-ms 3200]
//
// Exit code 0 when every checked recipe passes, 1 otherwise. Prints counts only, never page text.
import { parseArgs } from 'node:util';

const MIN_POOL = 6;
const MAX_POOL = 30;
const RETRY_CODES = new Set(['http_refused', 'network_failed']);

const { values } = parseArgs({ options: { only: { type: 'string' }, 'delay-ms': { type: 'string' } } });
const delayMs = Number(values['delay-ms'] ?? 3200);
const only = values.only === undefined ? undefined : new Set(values.only.split(','));

const backend = new URL('../packages/backend/dist/', import.meta.url);
const { RECIPES } = await import(new URL('modules/content/domain/library/index.js', backend).href);
const { fetchResearchPage } = await import(new URL('infrastructure/research/public-pages.js', backend).href);
const { quoteCandidates } = await import(new URL('modules/content/production/quote-candidates.js', backend).href);

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @type {Map<string, {page?: object, code?: string}>} */
const fetched = new Map();
async function fetchOnce(url) {
  const cached = fetched.get(url);
  if (cached !== undefined) return cached;
  let outcome = { code: 'not_fetched' };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      outcome = { page: await fetchResearchPage(url) };
      break;
    } catch (error) {
      outcome = { code: error?.code ?? 'fetch_failed' };
      if (!RETRY_CODES.has(outcome.code)) break;
      await pause(10_000 * (attempt + 1));
    }
  }
  fetched.set(url, outcome);
  await pause(delayMs);
  return outcome;
}

const rows = [];
for (const [key, recipe] of Object.entries(RECIPES)) {
  if (only !== undefined && !only.has(key)) continue;
  const pages = [];
  const failures = [];
  for (const url of recipe.pages) {
    const { page, code } = await fetchOnce(url);
    if (page === undefined) failures.push(`${code} ${url}`);
    else pages.push(page);
  }
  let pool = 0;
  if (failures.length === 0) {
    try {
      pool = quoteCandidates(pages).length;
      if (pool < MIN_POOL) failures.push(`pool_too_small ${String(pool)}`);
      if (pool > MAX_POOL) failures.push(`pool_near_limit ${String(pool)}`);
    } catch (error) {
      failures.push(`${error?.code ?? 'pool_failed'} (${String(recipe.pages.length)} pages)`);
    }
  }
  const characters = pages.reduce((sum, page) => sum + page.passages.reduce((n, p) => n + p.text.length, 0), 0);
  rows.push({ key, pages: recipe.pages.length, characters, pool, failures });
  const status = failures.length === 0 ? 'ok  ' : 'FAIL';
  process.stdout.write(
    `${status} ${key.padEnd(30)} pages=${String(recipe.pages.length)} chars=${String(characters).padStart(5)} pool=${String(pool).padStart(2)}${failures.length === 0 ? '' : `  ${failures.join('; ')}`}\n`,
  );
}

const failed = rows.filter((row) => row.failures.length > 0);
const urls = [...fetched.values()];
process.stdout.write(
  `\nrecipes=${String(rows.length)} passed=${String(rows.length - failed.length)} failed=${String(failed.length)} ` +
    `urls=${String(urls.length)} urls_accepted=${String(urls.filter((u) => u.page !== undefined).length)} ` +
    `urls_refused=${String(urls.filter((u) => u.page === undefined).length)}\n`,
);
process.exitCode = failed.length === 0 ? 0 : 1;
