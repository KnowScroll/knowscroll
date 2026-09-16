import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {createServer} from 'node:http';
import {promisify} from 'node:util';
import {
  checkMiniMaxQuota,
  MINIMAX_CERTIFICATION_BASE_URL,
  MINIMAX_QUOTA_URL,
  runMiniMaxCertification,
  validateQuotaResponse,
} from '../scripts/certify-minimax.ts';
import type {
  CertificationObservation,
  CertificationRequest,
  MiniMaxCertificationAdapter,
  MiniMaxCertificationOptions,
} from '../apps/worker/src/providers/certification-contract.ts';
import {createMiniMaxCertificationAdapter} from '../apps/worker/src/providers/minimax-certification.ts';

const execFileAsync = promisify(execFile);

async function checkout(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'knowscroll-runner-'));
  await execFileAsync('git', ['init', '-q'], {cwd:root});
  await (await import('node:fs/promises')).writeFile(join(root, '.gitignore'), 'artifacts/\n');
  return root;
}

function quota(): Response {
  return new Response(JSON.stringify({
    model_remains:[
      {model_name:'general',current_interval_remaining_percent:100,current_weekly_remaining_percent:95,current_interval_total_count:0},
      {model_name:'video',current_interval_remaining_percent:100,current_weekly_remaining_percent:100},
    ],
    base_resp:{status_code:0,status_msg:'SENTINEL_PROVIDER_MESSAGE'},
  }), {status:200,headers:{'content-type':'application/json'}});
}

function completed(requestHash: string, nativeContent: CertificationObservation['nativeContent'], text: string, stopReason: string): CertificationObservation {
  return {
    outcome:'completed',dispatched:true,httpStatus:200,requestHash,providerRequestId:'SENTINEL_PROVIDER_ID',
    usage:{inputTokens:12,outputTokens:8,cacheReadTokens:null,cacheWriteTokens:null,costUsd:null},
    nativeContent,text,stopReason,
  };
}

test('quota preflight uses only the fixed URL, no redirects, and validates exact general percentages', async () => {
  let called = 0;
  const fakeFetch: typeof fetch = async (input, init) => {
    called += 1;
    assert.equal(input, MINIMAX_QUOTA_URL);
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'manual');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer sk-cp-test-only');
    return quota();
  };
  assert.deepEqual(await checkMiniMaxQuota('sk-cp-test-only', fakeFetch), {intervalRemainingPercent:100,weeklyRemainingPercent:95});
  assert.equal(called, 1);
  assert.throws(() => validateQuotaResponse({model_remains:[
    {model_name:'general',current_interval_remaining_percent:24,current_weekly_remaining_percent:95},
  ],base_resp:{status_code:0}}), /below the certification floor/);
  assert.throws(() => validateQuotaResponse({model_remains:[],base_resp:{status_code:0}}), /exactly one general/);
});

test('runner performs three serial quota-gated cases and preserves opaque native continuation only in memory', async () => {
  const root = await checkout();
  let quotaCalls = 0;
  const fakeFetch: typeof fetch = async () => { quotaCalls += 1; return quota(); };
  const requests: CertificationRequest[] = [];
  let configured: MiniMaxCertificationOptions | undefined;
  const createAdapter = (options: MiniMaxCertificationOptions): MiniMaxCertificationAdapter => {
    configured = options;
    return {invoke: async (request) => {
      requests.push(request);
      const body = JSON.stringify({messages:request.messages,tools:request.tools,thinking:request.thinking,max_tokens:request.maxOutputTokens});
      const requestHash = createHash('sha256').update(body).digest('hex');
      await request.beforeDispatch({requestHash,inputBytes:Buffer.byteLength(body),maxOutputTokens:request.maxOutputTokens});
      if (requests.length === 1) return completed(requestHash, [{type:'text',text:'private-json-block'}], '{"classification":"certification-ok","count":3}', 'end_turn');
      if (requests.length === 2) return completed(requestHash, [
        {type:'thinking',thinking:'SENTINEL_PRIVATE_THINKING'},
        {type:'tool_use',id:'tool-secret-id',name:'lookup_fact',input:{topic:'Saturn'}},
      ], '', 'tool_use');
      return completed(requestHash, [{type:'text',text:'private-final-block'}], '{"planet":"Saturn","ringSystem":true}', 'end_turn');
    }};
  };

  const report = await runMiniMaxCertification(root, 'sk-cp-test-only', {fetch:fakeFetch,createAdapter});
  assert.equal(configured?.baseURL, MINIMAX_CERTIFICATION_BASE_URL);
  assert.equal(quotaCalls, 3);
  assert.equal(requests.length, 3);
  assert.deepEqual(requests.map((request) => request.maxOutputTokens), [512,2048,2048]);
  const continuation = requests[2]?.messages;
  assert.deepEqual(continuation?.[1]?.content, requests[1]?.messages ? [
    {type:'thinking',thinking:'SENTINEL_PRIVATE_THINKING'},
    {type:'tool_use',id:'tool-secret-id',name:'lookup_fact',input:{topic:'Saturn'}},
  ] : null);
  assert.deepEqual(continuation?.[2]?.content, [{type:'tool_result',tool_use_id:'tool-secret-id',content:'{"planet":"Saturn","ringSystem":true}'}]);
  assert.equal(report.attempts.length, 3);
  assert.ok(report.attempts.every((attempt) => attempt.status === 'completed' && Object.values(attempt.checks).every(Boolean)));
  const files = await (await import('node:fs/promises')).readdir(join(root, 'artifacts', 'minimax-certification', report.runId));
  const persisted = (await Promise.all(files.map((file) => readFile(join(root, 'artifacts', 'minimax-certification', report.runId, file), 'utf8')))).join('\n');
  assert.doesNotMatch(persisted, /SENTINEL|tool-secret-id|private-final-block|certification-ok/);
});

test('invalid tool call stops the dependent continuation without fabricating a result', async () => {
  const root = await checkout();
  let invocations = 0;
  const createAdapter = (): MiniMaxCertificationAdapter => ({invoke:async (request) => {
    invocations += 1;
    const body = JSON.stringify(request.messages);
    const requestHash = createHash('sha256').update(body).digest('hex');
    await request.beforeDispatch({requestHash,inputBytes:Buffer.byteLength(body),maxOutputTokens:request.maxOutputTokens});
    if (invocations === 1) return completed(requestHash, [], '{"classification":"certification-ok","count":3}', 'end_turn');
    return completed(requestHash, [{type:'tool_use',id:'wrong',name:'wrong_tool',input:{topic:7}}], '', 'tool_use');
  }});
  const report = await runMiniMaxCertification(root, 'sk-cp-test-only', {fetch:async()=>quota(),createAdapter});
  assert.equal(invocations, 2);
  assert.equal(report.attempts.length, 2);
  assert.equal(report.attempts[1]?.checks.exactToolCall, false);
});

test('runner drives the real SDK adapter through a local HTTP fixture with each prepared journal visible before transport', async (t) => {
  const root = await checkout();
  const bodies: Record<string, unknown>[] = [];
  let preparedBeforeTransport = true;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
    const artifactRoot = join(root, 'artifacts', 'minimax-certification');
    const runs = await (await import('node:fs/promises')).readdir(artifactRoot);
    const attempts = await (await import('node:fs/promises')).readdir(join(artifactRoot, runs[0]!));
    preparedBeforeTransport &&= attempts.includes(`attempt-${String(bodies.length).padStart(2, '0')}.jsonl`);
    const content = bodies.length === 1
      ? [{type:'text',text:'{"classification":"certification-ok","count":3}'}]
      : bodies.length === 2
        ? [{type:'thinking',thinking:'private fixture thought',signature:'opaque-signature'}, {type:'tool_use',id:'fixture-tool-1',name:'lookup_fact',input:{topic:'Saturn'}}]
        : [{type:'text',text:'{"planet":"Saturn","ringSystem":true}'}];
    response.statusCode = 200;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      id:`fixture-message-${bodies.length}`,type:'message',role:'assistant',model:'MiniMax-M3',content,
      stop_reason:bodies.length === 2 ? 'tool_use' : 'end_turn',stop_sequence:null,
      usage:{input_tokens:10,output_tokens:5},
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose())));
  const address = server.address();
  assert(address && typeof address === 'object');
  const loopback = `http://127.0.0.1:${address.port}`;
  const report = await runMiniMaxCertification(root, 'sk-cp-test-only', {
    fetch:async()=>quota(),
    createAdapter:(options) => {
      assert.equal(options.baseURL, MINIMAX_CERTIFICATION_BASE_URL);
      return createMiniMaxCertificationAdapter({apiKey:options.apiKey,baseURL:loopback});
    },
  });
  assert.equal(preparedBeforeTransport, true);
  assert.equal(bodies.length, 3);
  assert.deepEqual(bodies.map((body) => body.model), ['MiniMax-M3','MiniMax-M3','MiniMax-M3']);
  assert.deepEqual(bodies.map((body) => body.max_tokens), [512,2048,2048]);
  assert.deepEqual(bodies.map((body) => body.thinking), [{type:'disabled'},{type:'adaptive'},{type:'adaptive'}]);
  assert.equal('tools' in bodies[0]!, false);
  assert.deepEqual((bodies[1]?.tools as Array<Record<string, unknown>>).map((tool) => tool.name), ['lookup_fact']);
  assert.deepEqual((bodies[2]?.tools as Array<Record<string, unknown>>).map((tool) => tool.name), ['lookup_fact']);
  assert.ok(report.attempts.every((attempt) => attempt.status === 'completed' && Object.values(attempt.checks).every(Boolean)));
  assert.deepEqual((bodies[2]?.messages as unknown[])[1], {
    role:'assistant',
    content:[
      {type:'thinking',thinking:'private fixture thought',signature:'opaque-signature'},
      {type:'tool_use',id:'fixture-tool-1',name:'lookup_fact',input:{topic:'Saturn'}},
    ],
  });
  assert.deepEqual((bodies[2]?.messages as unknown[])[2], {
    role:'user',content:[{type:'tool_result',tool_use_id:'fixture-tool-1',content:'{"planet":"Saturn","ringSystem":true}'}],
  });
});

test('runner records a real SDK request deadline as timeout with unknown remote outcome', async (t) => {
  const root = await checkout();
  const server = createServer(async (_request, response) => {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 750));
    response.statusCode = 200;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({id:'late',type:'message',role:'assistant',model:'MiniMax-M3',content:[{type:'text',text:'late'}],stop_reason:'end_turn',usage:{input_tokens:1,output_tokens:1}}));
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  t.after(() => new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose())));
  const address = server.address();
  assert(address && typeof address === 'object');
  const loopback = `http://127.0.0.1:${address.port}`;
  const report = await runMiniMaxCertification(root, 'sk-cp-test-only', {
    fetch:async()=>quota(),
    createAdapter:(options)=>createMiniMaxCertificationAdapter({apiKey:options.apiKey,baseURL:loopback}),
    now:()=>new Date(Date.now() - 59_750),
  });
  assert.equal(report.attempts.length, 1);
  assert.equal(report.attempts[0]?.status, 'timeout');
  assert.equal(report.attempts[0]?.remoteOutcome, 'unknown');
  assert.equal(report.attempts[0]?.usage.inputTokens, null);
});

test('completed observations with inconsistent dispatch and HTTP evidence fail validation', async () => {
  const root = await checkout();
  const createAdapter = (): MiniMaxCertificationAdapter => ({invoke:async (request) => {
    const body = JSON.stringify(request.messages);
    const requestHash = createHash('sha256').update(body).digest('hex');
    await request.beforeDispatch({requestHash,inputBytes:Buffer.byteLength(body),maxOutputTokens:request.maxOutputTokens});
    return completed(requestHash, [], '{"classification":"certification-ok","count":3}', 'end_turn') satisfies CertificationObservation;
  }});
  const inconsistentFactory = (): MiniMaxCertificationAdapter => {
    const adapter = createAdapter();
    return {invoke:async(request)=>({...await adapter.invoke(request),dispatched:false,httpStatus:500})};
  };
  const report = await runMiniMaxCertification(root, 'sk-cp-test-only', {fetch:async()=>quota(),createAdapter:inconsistentFactory});
  assert.equal(report.attempts.length, 1);
  assert.equal(report.attempts[0]?.checks.dispatched, false);
  assert.equal(report.attempts[0]?.checks.httpSuccess, false);
});

test('runner refuses non-subscription keys before creating a journal or adapter', async () => {
  const root = await checkout();
  let created = false;
  await assert.rejects(runMiniMaxCertification(root, 'payg-key', {createAdapter:()=>{created=true;throw new Error('should not run');}}), /sk-cp-/);
  assert.equal(created, false);
});
