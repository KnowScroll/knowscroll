import assert from 'node:assert/strict';
import {createServer, type Server, type ServerResponse} from 'node:http';
import test from 'node:test';

import {CERTIFICATION_LIMITS, type CertificationRequest} from '../apps/worker/src/providers/certification-contract.js';
import {createMiniMaxCertificationAdapter} from '../apps/worker/src/providers/minimax-certification.js';

const API_KEY = 'sk-cp-test-secret-never-log';

function request(overrides: Partial<CertificationRequest> = {}): CertificationRequest {
  return {
    messages: [{role: 'user', content: 'Return ok'}],
    thinking: 'disabled',
    maxOutputTokens: 64,
    deadline: new Date(Date.now() + 5_000).toISOString(),
    signal: new AbortController().signal,
    beforeDispatch: async () => {},
    ...overrides,
  };
}

function success(content: unknown[] = [{type: 'text', text: 'ok'}], usage: unknown = {input_tokens: 7, output_tokens: 3}) {
  return {
    id: 'msg_fixture_1', type: 'message', role: 'assistant', model: 'MiniMax-M3',
    content, stop_reason: 'end_turn', stop_sequence: null, usage,
  };
}

async function fixture(
  handler: (body: Record<string, unknown>, req: import('node:http').IncomingMessage, res: ServerResponse) => {status?: number; body?: unknown; raw?: string; headers?: Record<string, string>} | Promise<{status?: number; body?: unknown; raw?: string; headers?: Record<string, string>}>,
): Promise<{baseURL: string; close: () => Promise<void>; requests: () => number}> {
  let count = 0;
  const server: Server = createServer(async (req, res) => {
    count += 1;
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const result = await handler(JSON.parse(rawBody) as Record<string, unknown>, req, res);
    res.statusCode = result.status ?? 200;
    res.setHeader('content-type', 'application/json');
    for (const [name, value] of Object.entries(result.headers ?? {})) res.setHeader(name, value);
    res.end(result.raw ?? JSON.stringify(result.body ?? success()));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  return {
    baseURL: `http://127.0.0.1:${address.port}`,
    requests: () => count,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test('uses the real SDK route and preserves native ordered continuation blocks and tools', async (t) => {
  const signature = 'opaque-signature-abc';
  const messages: CertificationRequest['messages'] = [
    {role: 'user', content: [{type: 'text', text: 'calculate'}]},
    {role: 'assistant', content: [
      {type: 'thinking', thinking: 'private chain', signature, provider_extension: {keep: true}},
      {type: 'tool_use', id: 'tool_1', name: 'sum', input: {a: 2, b: 3}, opaque: ['x', 4]},
    ]},
    {role: 'user', content: [{type: 'tool_result', tool_use_id: 'tool_1', content: [{type: 'text', text: '5'}]}]},
  ];
  const tools = [{name: 'sum', description: 'Add numbers', input_schema: {type: 'object', properties: {a: {type: 'number'}, b: {type: 'number'}}, required: ['a', 'b']}}] satisfies NonNullable<CertificationRequest['tools']>;
  let wire: Record<string, unknown> | null = null;
  let reservedBytes: number | null = null;
  let path = '';
  let reservations = 0;
  const server = await fixture((body, req) => {
    wire = body;
    path = req.url ?? '';
    return {body: success([
      {type: 'thinking', thinking: 'next', signature: 'response-signature', unknown_field: {n: 1}},
      {type: 'text', text: '5'},
    ], {input_tokens: 12, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1})};
  });
  t.after(server.close);

  const result = await createMiniMaxCertificationAdapter({apiKey: API_KEY, baseURL: server.baseURL}).invoke(request({
    messages, tools, thinking: 'adaptive', maxOutputTokens: 321,
    beforeDispatch: async (metadata) => {
      reservations += 1;
      reservedBytes = metadata.inputBytes;
      assert.equal(metadata.maxOutputTokens, 321);
      assert.match(metadata.requestHash, /^[a-f0-9]{64}$/);
    },
  }));

  assert.equal(path, '/messages');
  assert.equal(server.requests(), 1);
  assert.equal(reservations, 1);
  const observedWire = wire as Record<string, unknown> | null;
  assert(observedWire);
  assert.equal(reservedBytes, Buffer.byteLength(JSON.stringify(observedWire), 'utf8'));
  assert.deepEqual(observedWire.messages, messages);
  assert.deepEqual(observedWire.tools, tools);
  assert.deepEqual(observedWire.thinking, {type: 'adaptive'});
  assert.equal(observedWire.model, 'MiniMax-M3');
  assert.equal(observedWire.max_tokens, 321);
  assert.equal(result.outcome, 'completed');
  assert.equal(result.text, '5');
  assert.deepEqual(result.usage, {inputTokens: 12, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1, costUsd: null});
  assert.deepEqual(result.nativeContent[0], {type: 'thinking', thinking: 'next', signature: 'response-signature', unknown_field: {n: 1}});
});

test('continues from the exact raw thinking and tool-use response returned by the first invocation', async (t) => {
  const firstContent = [
    {type: 'thinking', thinking: 'opaque reasoning', signature: 'sig-1', vendor_field: {sequence: [3, 1, 2]}},
    {type: 'tool_use', id: 'call-77', name: 'lookup', input: {key: 'alpha'}, vendor_tag: 'preserve-me'},
  ];
  const seenBodies: Record<string, unknown>[] = [];
  const server = await fixture((body) => {
    seenBodies.push(body);
    return seenBodies.length === 1
      ? {body: {...success(firstContent, {input_tokens: 8, output_tokens: 4}), stop_reason: 'tool_use'}}
      : {body: success([{type: 'text', text: 'continued'}], {input_tokens: 13, output_tokens: 2})};
  });
  t.after(server.close);
  const adapter = createMiniMaxCertificationAdapter({apiKey: API_KEY, baseURL: server.baseURL});
  const first = await adapter.invoke(request({
    messages: [{role: 'user', content: 'Use lookup'}],
    thinking: 'adaptive',
    tools: [{name: 'lookup', description: 'Lookup one key', input_schema: {type: 'object', properties: {key: {type: 'string'}}, required: ['key']}}],
  }));
  assert.equal(first.outcome, 'completed');
  assert.deepEqual(first.nativeContent, firstContent);

  const continuation: CertificationRequest['messages'] = [
    {role: 'user', content: 'Use lookup'},
    {role: 'assistant', content: first.nativeContent},
    {role: 'user', content: [{type: 'tool_result', tool_use_id: 'call-77', content: [{type: 'text', text: 'value-alpha'}]}]},
  ];
  const second = await adapter.invoke(request({messages: continuation, thinking: 'adaptive'}));
  assert.equal(second.outcome, 'completed');
  assert.equal(second.text, 'continued');
  assert.equal(server.requests(), 2);
  assert.deepEqual(seenBodies[1]?.messages, continuation);
  assert.deepEqual((seenBodies[1]?.messages as CertificationRequest['messages'])[1]?.content, firstContent);
});

for (const status of [429, 500]) {
  test(`does not retry HTTP ${status}`, async (t) => {
    const server = await fixture(() => ({status, body: {error: {message: API_KEY, type: 'fixture_error'}}}));
    t.after(server.close);
    const result = await createMiniMaxCertificationAdapter({apiKey: API_KEY, baseURL: server.baseURL}).invoke(request());
    assert.equal(result.outcome, 'http_error');
    assert.equal(result.dispatched, true);
    assert.equal(result.httpStatus, status);
    assert.equal(server.requests(), 1);
    assert.equal(JSON.stringify(result).includes(API_KEY), false);
  });
}

test('rejects output and actual UTF-8 input bounds before dispatch', async () => {
  let calls = 0;
  const adapter = createMiniMaxCertificationAdapter({apiKey: API_KEY, fetch: async () => {
    calls += 1;
    return new Response(JSON.stringify(success()), {status: 200});
  }});
  const output = await adapter.invoke(request({maxOutputTokens: CERTIFICATION_LIMITS.maxOutputTokens + 1}));
  assert.equal(output.outcome, 'not_dispatched');
  const oversized = await adapter.invoke(request({messages: [{role: 'user', content: '€'.repeat(CERTIFICATION_LIMITS.maxInputBytes)}]}));
  assert.equal(oversized.outcome, 'not_dispatched');
  assert.match(oversized.requestHash ?? '', /^[a-f0-9]{64}$/);
  assert.equal(calls, 0);
});

test('pre-abort and reservation rejection never fetch', async () => {
  let calls = 0;
  const adapter = createMiniMaxCertificationAdapter({apiKey: API_KEY, fetch: async () => {
    calls += 1;
    return new Response(JSON.stringify(success()), {status: 200});
  }});
  const controller = new AbortController();
  controller.abort();
  assert.equal((await adapter.invoke(request({signal: controller.signal}))).outcome, 'aborted');
  const rejected = await adapter.invoke(request({beforeDispatch: async () => { throw new Error(API_KEY); }}));
  assert.equal(rejected.outcome, 'not_dispatched');
  assert.equal(rejected.dispatched, false);
  assert.equal(JSON.stringify(rejected).includes(API_KEY), false);
  assert.equal(calls, 0);
});

test('deadline aborts an in-flight request and reports uncertain dispatched timeout', {timeout: 5_000}, async (t) => {
  let observed!: () => void;
  const requestObserved = new Promise<void>((resolve) => { observed = resolve; });
  let closed!: () => void;
  const responseClosed = new Promise<void>((resolve) => { closed = resolve; });
  let releaseHandler!: () => void;
  const handlerReleased = new Promise<void>((resolve) => { releaseHandler = resolve; });
  const server = await fixture(async (_body, _req, response) => {
    response.once('close', closed);
    observed();
    await Promise.race([responseClosed, handlerReleased]);
    return {body: success()};
  });
  const controller = new AbortController();
  const now = Date.now();
  t.mock.timers.enable({apis: ['Date', 'setTimeout'], now});
  t.after(async () => {
    controller.abort();
    releaseHandler();
    try { await server.close(); } finally { t.mock.timers.reset(); }
  });
  const pending = createMiniMaxCertificationAdapter({apiKey: API_KEY, baseURL: server.baseURL}).invoke(request({
    deadline: new Date(Date.now() + 30).toISOString(),
    signal: controller.signal,
  }));
  await requestObserved;
  assert.equal(server.requests(), 1);
  t.mock.timers.tick(30);
  const result = await pending;
  await responseClosed;
  assert.equal(result.outcome, 'timeout');
  assert.equal(result.dispatched, true);
  assert.equal(result.httpStatus, null);
  assert.deepEqual(result.usage, {inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null});
});

test('deadline before transport remains undispatched with no remote request', {timeout: 5_000}, async (t) => {
  const server = await fixture(() => ({body: success()}));
  let entered!: () => void;
  const beforeDispatchEntered = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const beforeDispatchReleased = new Promise<void>((resolve) => { release = resolve; });
  const controller = new AbortController();
  const now = Date.now();
  t.mock.timers.enable({apis: ['Date', 'setTimeout'], now});
  t.after(async () => {
    controller.abort();
    release();
    try { await server.close(); } finally { t.mock.timers.reset(); }
  });

  const pending = createMiniMaxCertificationAdapter({apiKey: API_KEY, baseURL: server.baseURL}).invoke(request({
    deadline: new Date(Date.now() + 30).toISOString(),
    signal: controller.signal,
    beforeDispatch: async () => {
      entered();
      await beforeDispatchReleased;
    },
  }));
  await beforeDispatchEntered;
  t.mock.timers.tick(30);
  release();
  const result = await pending;
  assert.equal(result.outcome, 'timeout');
  assert.equal(result.dispatched, false);
  assert.equal(result.httpStatus, null);
  assert.match(result.requestHash ?? '', /^[a-f0-9]{64}$/);
  assert.equal(server.requests(), 0);
  assert.deepEqual(result.usage, {inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null});
});

test('missing usage remains nullable and is an SDK compatibility failure', async (t) => {
  let caseNumber = 0;
  const server = await fixture(() => {
    caseNumber += 1;
    if (caseNumber === 1) {
      const body = success([{type: 'text', text: 'ok'}]);
      delete (body as {usage?: unknown}).usage;
      return {body};
    }
    return {raw: '{not-json'};
  });
  t.after(server.close);
  const adapter = createMiniMaxCertificationAdapter({apiKey: API_KEY, baseURL: server.baseURL});
  const missing = await adapter.invoke(request());
  assert.equal(missing.outcome, 'invalid_response');
  assert.deepEqual(missing.usage, {inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null});
  const malformed = await adapter.invoke(request());
  assert.equal(malformed.outcome, 'invalid_response');
  assert.equal(malformed.httpStatus, 200);
  assert.equal(JSON.stringify(malformed).includes(API_KEY), false);
});

test('caller abort after dispatch reports aborted with unknown remote outcome', async (t) => {
  let observed!: () => void;
  const requestObserved = new Promise<void>((resolve) => { observed = resolve; });
  const server = await fixture(async () => {
    observed();
    await new Promise((resolve) => setTimeout(resolve, 100));
    return {body: success()};
  });
  t.after(server.close);
  const controller = new AbortController();
  const pending = createMiniMaxCertificationAdapter({apiKey: API_KEY, baseURL: server.baseURL}).invoke(request({signal: controller.signal}));
  await requestObserved;
  controller.abort();
  const result = await pending;
  assert.equal(result.outcome, 'aborted');
  assert.equal(result.dispatched, true);
  assert.equal(result.httpStatus, null);
  assert.equal(server.requests(), 1);
});

test('does not follow redirects or send credentials to the redirect target', async (t) => {
  const target = await fixture(() => ({body: success()}));
  t.after(target.close);
  const source = await fixture(() => ({status: 302, headers: {location: `${target.baseURL}/messages`}, body: {}}));
  t.after(source.close);
  const result = await createMiniMaxCertificationAdapter({apiKey: API_KEY, baseURL: source.baseURL}).invoke(request());
  assert.equal(result.outcome, 'http_error');
  assert.equal(result.httpStatus, 302);
  assert.equal(source.requests(), 1);
  assert.equal(target.requests(), 0);
});

test('HTTP 200 SDK validation failure retains independently valid raw usage', async (t) => {
  const server = await fixture(() => ({body: {
    id: 'bad response id with spaces', type: 'message', role: 'assistant', model: 'MiniMax-M3',
    content: [{type: 'unexpected', secret: API_KEY}], stop_reason: 'end_turn',
    usage: {input_tokens: 11, output_tokens: 9, cache_read_input_tokens: -1},
  }}));
  t.after(server.close);
  const result = await createMiniMaxCertificationAdapter({apiKey: API_KEY, baseURL: server.baseURL}).invoke(request());
  assert.equal(result.outcome, 'invalid_response');
  assert.deepEqual(result.usage, {inputTokens: 11, outputTokens: 9, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null});
  assert.equal(result.providerRequestId, null);
  assert.deepEqual(result.nativeContent, []);
  assert.equal(JSON.stringify(result).includes(API_KEY), false);
});

test('snapshots native input before waiting for the durable reservation', async () => {
  const messages: CertificationRequest['messages'] = [{role: 'user', content: [{type: 'text', text: 'original'}]}];
  let wire: Record<string, unknown> | null = null;
  const adapter = createMiniMaxCertificationAdapter({apiKey: API_KEY, fetch: async (_input, init) => {
    wire = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify(success()), {status: 200, headers: {'content-type': 'application/json'}});
  }});
  const pending = adapter.invoke(request({messages, beforeDispatch: async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }}));
  const firstMessage = messages[0];
  assert(firstMessage && Array.isArray(firstMessage.content));
  const firstBlock = firstMessage.content[0];
  assert(firstBlock);
  firstBlock.text = 'mutated';
  assert.equal((await pending).outcome, 'completed');
  assert.deepEqual((wire as Record<string, unknown> | null)?.messages, [{role: 'user', content: [{type: 'text', text: 'original'}]}]);
});

test('classifies a fetch rejection as transport error without exposing it', async () => {
  const result = await createMiniMaxCertificationAdapter({apiKey: API_KEY, fetch: async () => {
    throw new Error(`socket failed ${API_KEY}`);
  }}).invoke(request());
  assert.equal(result.outcome, 'transport_error');
  assert.equal(result.dispatched, true);
  assert.equal(result.httpStatus, null);
  assert.equal(JSON.stringify(result).includes(API_KEY), false);
});
