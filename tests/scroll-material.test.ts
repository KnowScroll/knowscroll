/**
 * #162 — where a model-written Scroll's material may come from, and how it is read (ADR-0041 §1–§2).
 * Pure: the allowlist (OpenStax refused by name), the visible-text rules and the families. Worker:
 * the fetcher, against a mocked network only — redirects are checked hop by hop, nothing but the
 * allowlist is ever requested, no cookie or credential is sent, and the size is bounded.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { checkMaterialUrl, extractVisibleText, MATERIAL_FAMILIES, MATERIAL_LIMITS, offeredText } from '../packages/core/src/scrolls/material.ts';
import { fetchMaterial } from '../apps/worker/src/scrolls/fetch-material.ts';

test('the allowlist: US federal public-domain hosts over https, OpenStax refused by name', () => {
  for (const url of [
    'https://science.nasa.gov/sun/facts/', 'https://spaceplace.nasa.gov/seasons/en/', 'https://www.nasa.gov/a/',
    'https://oceanservice.noaa.gov/facts/tides.html', 'https://www.noaa.gov/b', 'https://www.weather.gov/c', 'https://www.usgs.gov/d',
  ]) assert.equal(checkMaterialUrl(url).ok, true, url);
  const nasa = checkMaterialUrl('https://SCIENCE.nasa.gov/sun/facts/#top');
  assert.ok(nasa.ok);
  assert.equal(nasa.url, 'https://science.nasa.gov/sun/facts/', 'normalized, without the fragment');
  assert.deepEqual([nasa.host.publisher, nasa.host.family.key, nasa.host.keyPrefix], ['NASA', 'fam.nasa', 'nasa']);
  const usgs = checkMaterialUrl('https://www.usgs.gov/d');
  assert.ok(usgs.ok);
  assert.equal(usgs.host.family.key, 'fam.usgs');

  const refused = (url: string) => { const r = checkMaterialUrl(url); return r.ok ? 'accepted' : r.reason; };
  assert.equal(refused('https://openstax.org/books/anatomy-and-physiology-2e/pages/1-5-homeostasis'), 'openstax_excluded');
  assert.equal(refused('https://cnx.openstax.org/contents/x'), 'openstax_excluded');
  assert.equal(refused('http://openstax.org/books/x'), 'openstax_excluded');
  assert.equal(refused('http://science.nasa.gov/sun/facts/'), 'not_https');
  assert.equal(refused('https://user:secret@science.nasa.gov/sun/facts/'), 'credentials_in_url');
  assert.equal(refused('https://science.nasa.gov:8443/sun/facts/'), 'port_not_allowed');
  assert.equal(refused('https://en.wikipedia.org/wiki/Tide'), 'host_not_allowed');
  assert.equal(refused('https://nasa.gov.example.test/x'), 'host_not_allowed');
  // A host named like an Object.prototype key is not on the allowlist either (review of #178).
  assert.equal(refused('https://constructor/x'), 'host_not_allowed');
  assert.equal(refused('https://__proto__/x'), 'host_not_allowed');
  assert.equal(refused('not a url'), 'not_a_url');
});

test('the policy defines its families exactly as the substrate does', () => {
  const substrate = JSON.parse(readFileSync('content/substrate.json', 'utf8')) as { families: { key: string; kind: string; description: string }[] };
  let shared = 0;
  for (const family of Object.values(MATERIAL_FAMILIES)) {
    const loaded = substrate.families.find(f => f.key === family.key);
    if (!loaded) continue;
    shared += 1;
    assert.deepEqual(family, loaded);
  }
  assert.equal(shared, 2, 'fam.nasa and fam.noaa come from the substrate; fam.usgs is new');
});

const PAGE = `<!doctype html><html><head><title>Tides &amp; the Moon | Fixture</title><style>p{color:red}</style>
<script>var sentence = "never visible";</script></head>
<body><nav><a href="/">Home</a></nav>
<main><h1>What are&nbsp;tides?</h1><p>Fixture text, written by hand. The Moon&#8217;s pull raises the sea.</p><!-- a comment -->
<svg><title>an icon</title></svg><p>Two   bulges,<br>two tides.</p></main>
<footer><p>Footer words</p></footer></body></html>`;

test('visible text: the snapshot tool\'s rules and the shared normalization; the <main> text is a passage of it', () => {
  const extracted = extractVisibleText(PAGE);
  assert.equal(extracted.text, 'Home What are tides? Fixture text, written by hand. The Moon’s pull raises the sea. Two bulges, two tides. Footer words');
  assert.equal(extracted.focus, 'What are tides? Fixture text, written by hand. The Moon’s pull raises the sea. Two bulges, two tides.');
  assert.ok(extracted.text.includes(extracted.focus!));
  assert.equal(extracted.title, 'Tides & the Moon | Fixture');
  assert.equal(extractVisibleText('<p>No main element here.</p>').focus, null);
  // An attribute value may contain ">" without ending the tag.
  assert.equal(extractVisibleText('<p title="a > b">Inside</p>').text, 'Inside');
});

test('the text offered to the writer: <main> first, the whole page when <main> is too short to quote from', () => {
  const article = 'The Moon pulls on the ocean. '.repeat(20).trim();
  assert.equal(offeredText({ text: `Nav ${article} Footer`, focus: article }), article);
  assert.equal(offeredText({ text: `Nav ${article} Footer`, focus: 'A short hero line' }), `Nav ${article} Footer`);
  assert.equal(offeredText({ text: `Nav ${article} Footer`, focus: null }), `Nav ${article} Footer`);
});

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
const page = (body: string) => `<html><head><title>Fixture page</title></head><body><main><p>${body}</p></main></body></html>`;
const html = (body: string, headers: Record<string, string> = {}) => new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });
const redirect = (location: string, status = 301) => new Response(null, { status, headers: { location } });
type Seen = { url: string; init: RequestInit };
function network(routes: Record<string, () => Response>) {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    const route = routes[String(url)];
    if (!route) throw new TypeError(`fixture network: nothing at ${String(url)}`);
    return route();
  }) as typeof fetch;
  return { fetchImpl, seen };
}

test('fetch: one allowlisted page, no cookie or credential sent, hashed exactly as stored', async () => {
  const body = words(120);
  const net = network({ 'https://science.nasa.gov/fixture/tides/': () => html(page(body)) });
  const now = () => new Date('2026-09-24T10:00:00.000Z');
  const result = await fetchMaterial('https://science.nasa.gov/fixture/tides/', { fetchImpl: net.fetchImpl, now });
  assert.ok(result.ok, JSON.stringify(result));
  const m = result.material;
  assert.equal(m.url, 'https://science.nasa.gov/fixture/tides/');
  assert.equal(m.text, body);
  assert.equal(m.focus, body);
  assert.equal(m.title, 'Fixture page');
  assert.equal(m.contentSha256, createHash('sha256').update(body, 'utf8').digest('hex'));
  assert.equal(m.retrievedAt, '2026-09-24T10:00:00.000Z');
  assert.equal(net.seen.length, 1);
  const init = net.seen[0]!.init;
  assert.equal(init.redirect, 'manual');
  assert.equal(init.credentials, 'omit');
  const headers = new Headers(init.headers);
  assert.equal(headers.get('cookie'), null);
  assert.equal(headers.get('authorization'), null);
});

test('fetch: a redirect is followed only within the allowlist, hop by hop', async () => {
  const body = words(120);
  const within = network({
    'https://science.nasa.gov/fixture/tides': () => redirect('/fixture/tides/'),
    'https://science.nasa.gov/fixture/tides/': () => html(page(body)),
  });
  const followed = await fetchMaterial('https://science.nasa.gov/fixture/tides', { fetchImpl: within.fetchImpl });
  assert.ok(followed.ok);
  assert.equal(followed.material.url, 'https://science.nasa.gov/fixture/tides/', 'the source is the final URL');

  for (const [target, reason] of [
    ['https://openstax.org/books/x', 'openstax_excluded'],
    ['https://en.wikipedia.org/wiki/Tide', 'host_not_allowed'],
    ['http://science.nasa.gov/fixture/tides/', 'not_https'],
    ['https://constructor/internal', 'host_not_allowed'],
  ] as const) {
    const net = network({ 'https://science.nasa.gov/fixture/moved/': () => redirect(target, 302) });
    assert.deepEqual(await fetchMaterial('https://science.nasa.gov/fixture/moved/', { fetchImpl: net.fetchImpl }), { ok: false, reason });
    assert.deepEqual(net.seen.map(s => s.url), ['https://science.nasa.gov/fixture/moved/'], `${target} is never requested`);
  }

  const loop = network({
    'https://science.nasa.gov/a/': () => redirect('/b/'), 'https://science.nasa.gov/b/': () => redirect('/c/'),
    'https://science.nasa.gov/c/': () => redirect('/d/'), 'https://science.nasa.gov/d/': () => redirect('/e/'),
  });
  assert.deepEqual(await fetchMaterial('https://science.nasa.gov/a/', { fetchImpl: loop.fetchImpl }), { ok: false, reason: 'too_many_redirects' });
  assert.equal(loop.seen.length, MATERIAL_LIMITS.maxRedirects + 1);
});

test('fetch: OpenStax and off-allowlist pages are refused before any request', async () => {
  const net = network({});
  assert.deepEqual(await fetchMaterial('https://openstax.org/books/anatomy-and-physiology-2e/pages/1-5-homeostasis', { fetchImpl: net.fetchImpl }), { ok: false, reason: 'openstax_excluded' });
  assert.deepEqual(await fetchMaterial('https://en.wikipedia.org/wiki/Tide', { fetchImpl: net.fetchImpl }), { ok: false, reason: 'host_not_allowed' });
  assert.equal(net.seen.length, 0);
});

test('fetch: a failed, non-HTML, oversized or near-empty page is refused', async () => {
  const at = 'https://www.usgs.gov/fixture/page';
  const refusal = async (response: () => Response) => fetchMaterial(at, { fetchImpl: network({ [at]: response }).fetchImpl });
  assert.deepEqual(await refusal(() => new Response('gone', { status: 404, headers: { 'content-type': 'text/html' } })), { ok: false, reason: 'http_status', httpStatus: 404 });
  assert.deepEqual(await refusal(() => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })), { ok: false, reason: 'not_html' });
  assert.deepEqual(await refusal(() => html(page(words(20)))), { ok: false, reason: 'too_little_text' });
  // A missing page served as HTTP 200 (NOAA's live site does this) is not material, however much
  // navigation text surrounds it.
  const soft404 = `<html><head><title>Page Not Found: Error 404</title></head><body><main><p>${words(120)}</p></main></body></html>`;
  assert.deepEqual(await refusal(() => html(soft404)), { ok: false, reason: 'page_not_found' });
  // A declared length over the bound is refused unread; an undeclared one is cut off while streaming.
  assert.deepEqual(await refusal(() => html(page(words(120)), { 'content-length': String(MATERIAL_LIMITS.maxBytes + 1) })), { ok: false, reason: 'too_large' });
  let pulled = 0;
  const endless = new ReadableStream<Uint8Array>({ pull(controller) { pulled += 1; controller.enqueue(new Uint8Array(64 * 1024).fill(0x61)); } });
  assert.deepEqual(await refusal(() => new Response(endless, { status: 200, headers: { 'content-type': 'text/html' } })), { ok: false, reason: 'too_large' });
  assert.ok(pulled * 64 * 1024 <= MATERIAL_LIMITS.maxBytes + 2 * 64 * 1024, 'reading stopped at the bound');
  assert.deepEqual(await fetchMaterial(at, { fetchImpl: (async () => { throw new TypeError('socket hang up'); }) as typeof fetch }), { ok: false, reason: 'fetch_failed' });
});
