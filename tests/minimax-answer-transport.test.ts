/**
 * #132 — the worker-only MiniMax answer transport, with a mocked fetch (no network, no key): only a
 * subscription key, quota preflight before scheduling, exactly the reserved bytes to the fixed
 * route with no redirects, and honest outcome mapping.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMiniMaxAnswerTransport, MINIMAX_ANSWER_URL } from '../apps/worker/src/providers/minimax-answer.ts';
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
