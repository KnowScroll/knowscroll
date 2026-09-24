/**
 * #132 — the worker-only MiniMax answer transport, with a mocked fetch (no network, no key): only a
 * subscription key, quota preflight before scheduling, exactly the reserved bytes to the fixed
 * route with no redirects, and honest outcome mapping.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMiniMaxAnswerTransport, MINIMAX_ANSWER_URL } from '../apps/worker/src/providers/minimax-answer.ts';
import { createReadinessGate } from '../apps/worker/src/reasoning/answer-worker.ts';
import { MINIMAX_QUOTA_URL } from '../apps/worker/src/providers/minimax-quota.ts';
import type { AnswerWork } from '../packages/db/src/reasoning-answers.ts';

const key = `sk-cp-${'x'.repeat(24)}`;
const quota = (interval: number, weekly: number) => ({ base_resp: { status_code: 0 }, model_remains: [{ model_name: 'general', current_interval_remaining_percent: interval, current_weekly_remaining_percent: weekly }] });
const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const work = {} as AnswerWork;

test('only a subscription key is accepted', () => {
  assert.throws(() => createMiniMaxAnswerTransport({ apiKey: 'sk-api-paygo' }), /subscription/);
});

test('the quota preflight gates scheduling: below 25% interval or weekly is not ready', async () => {
  for (const [interval, weekly, ok] of [[80, 60, true], [24, 90, false], [90, 10, false]] as const) {
    const t = createMiniMaxAnswerTransport({ apiKey: key, fetchImpl: async url => { assert.equal(String(url), MINIMAX_QUOTA_URL); return json(200, quota(interval, weekly)); } });
    assert.equal((await t.ready(new AbortController().signal)).ok, ok, `${interval}/${weekly}`);
  }
});

test('send posts exactly the reserved bytes once to the fixed route and reads the text blocks', async () => {
  const bytes = new TextEncoder().encode('{"model":"MiniMax-M3"}');
  const seen: { url: string; init: RequestInit }[] = [];
  const t = createMiniMaxAnswerTransport({ apiKey: key, fetchImpl: async (url, init) => {
    seen.push({ url: String(url), init: init! });
    return json(200, { content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: '{"answer":' }, { type: 'text', text: 'null}' }], usage: { input_tokens: 812, output_tokens: 40 } });
  } });
  const o = await t.send({ body: bytes, maxOutputTokens: 1024, signal: new AbortController().signal, work });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.url, MINIMAX_ANSWER_URL);
  assert.equal(seen[0]!.init.redirect, 'manual');
  assert.deepEqual(new Uint8Array(seen[0]!.init.body as Buffer), bytes);
  assert.equal((seen[0]!.init.headers as Record<string, string>)['x-api-key'], key);
  assert.equal(o.outcome, 'success');
  assert.equal(o.text, '{"answer":null}', 'only text blocks, never the thinking block');
  assert.deepEqual(o.usage, { inputTokens: 812, outputTokens: 40, cacheReadTokens: null, cacheWriteTokens: null, costMicroUsd: null });
});

test('a rate limit or server error is an error; a request refused as invalid is a refusal; a lost connection throws', async () => {
  const outcome = async (status: number) => (await createMiniMaxAnswerTransport({ apiKey: key, fetchImpl: async () => json(status, { error: 'x' }) })
    .send({ body: new Uint8Array([1]), maxOutputTokens: 1, signal: new AbortController().signal, work })).outcome;
  assert.equal(await outcome(429), 'error');
  assert.equal(await outcome(500), 'error');
  assert.equal(await outcome(400), 'refusal');
  const lost = createMiniMaxAnswerTransport({ apiKey: key, fetchImpl: async () => { throw new TypeError('socket hang up'); } });
  await assert.rejects(lost.send({ body: new Uint8Array([1]), maxOutputTokens: 1, signal: new AbortController().signal, work }));
});

test('review I4: cache usage is recorded like the certified route; a gateway timeout is unconfirmed, not terminal', async () => {
  const t = createMiniMaxAnswerTransport({ apiKey: key, fetchImpl: async () => json(200, {
    content: [{ type: 'text', text: '{}' }], usage: { input_tokens: 1, output_tokens: 180, cache_read_input_tokens: 2400, cache_creation_input_tokens: 12 } }) });
  const observed = await t.send({ body: new Uint8Array([1]), maxOutputTokens: 1, signal: new AbortController().signal, work });
  assert.deepEqual(observed.usage, { inputTokens: 1, outputTokens: 180, cacheReadTokens: 2400, cacheWriteTokens: 12, costMicroUsd: null });
  const disposition = async (status: number) => (await createMiniMaxAnswerTransport({ apiKey: key, fetchImpl: async () => json(status, { error: 'x' }) })
    .send({ body: new Uint8Array([1]), maxOutputTokens: 1, signal: new AbortController().signal, work })).remoteDisposition;
  assert.equal(await disposition(502), 'unconfirmed');
  assert.equal(await disposition(504), 'unconfirmed');
  assert.equal(await disposition(500), 'terminal');
  assert.equal(await disposition(429), 'terminal');
});

test('review I2: readiness is asked at most once per window while work waits, and a refusal backs off', async () => {
  let calls = 0, now = 0, answer: { ok: true } | { ok: false; reason: string } = { ok: true };
  const gate = createReadinessGate({ kind: 'minimax', ready: async () => { calls += 1; return answer; }, send: async () => { throw new Error('unused'); } },
    { okMs: 30_000, failMs: 60_000, now: () => now });
  const signal = new AbortController().signal;
  for (let i = 0; i < 5; i += 1) { assert.equal((await gate(signal)).ok, true); now += 300; }
  assert.equal(calls, 1, 'five blocked passes, one quota request');
  now += 30_000; answer = { ok: false, reason: 'provider_quota_preflight_failed' };
  assert.equal((await gate(signal)).ok, false);
  now += 59_000; answer = { ok: true };
  assert.equal((await gate(signal)).ok, false, 'still backing off');
  assert.equal(calls, 2);
  now += 2_000;
  assert.equal((await gate(signal)).ok, true);
  assert.equal(calls, 3);
});

test('review M5: a quota endpoint that never answers makes the transport not ready within its timeout', async () => {
  const hung = createMiniMaxAnswerTransport({ apiKey: key, quotaTimeoutMs: 50,
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))); }) });
  const started = Date.now();
  assert.deepEqual(await hung.ready(new AbortController().signal), { ok: false, reason: 'provider_quota_preflight_failed' });
  assert.ok(Date.now() - started < 2_000);
});
