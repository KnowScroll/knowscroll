import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  CERTIFICATION_LIMITS,
  type CertificationObservation,
  type MiniMaxCertificationAdapter,
  type MiniMaxCertificationOptions,
  type NativeMessage,
  type NativeTool,
} from '../apps/worker/src/providers/certification-contract.ts';
import {
  CertificationJournal,
  inspectCertificationRun,
  type CaseChecks,
  type CertificationCase,
  type PublicCertificationReport,
} from '../apps/worker/src/providers/certification-journal.ts';
import {createMiniMaxCertificationAdapter} from '../apps/worker/src/providers/minimax-certification.ts';
import {checkMiniMaxQuota,MINIMAX_QUOTA_URL,validateQuotaResponse,type QuotaObservation} from '../apps/worker/src/providers/minimax-quota.ts';
export {checkMiniMaxQuota,MINIMAX_QUOTA_URL,validateQuotaResponse};

export const MINIMAX_CERTIFICATION_BASE_URL = 'https://api.minimax.io/anthropic/v1';

const JSON_PROMPT = 'Return only this JSON object, with no markdown or extra keys: {"classification":"certification-ok","count":3}';
const TOOL_PROMPT = 'Call lookup_fact exactly once with topic set to Saturn. Do not answer from memory. After the tool result, return only its JSON object with no markdown or extra keys.';
const TOOL_RESULT = '{"planet":"Saturn","ringSystem":true}';
const TOOL: NativeTool = {
  name:'lookup_fact',
  description:'Return the fixed local certification fact for one topic.',
  input_schema:{type:'object',properties:{topic:{type:'string'}},required:['topic'],additionalProperties:false},
};

type AdapterFactory = (options: MiniMaxCertificationOptions) => MiniMaxCertificationAdapter;
type RunDependencies = {fetch?:typeof fetch; createAdapter:AdapterFactory; now?:()=>Date};

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseExactJson(text: string, expected: Record<string, string | number | boolean>): boolean {
  try {
    const value = JSON.parse(text) as unknown;
    return object(value) && Object.keys(value).length === Object.keys(expected).length &&
      Object.entries(expected).every(([key, expectedValue]) => value[key] === expectedValue);
  } catch { return false; }
}

function findToolCall(observation: CertificationObservation): {id:string;block:Record<string, unknown>} | null {
  if (observation.outcome !== 'completed' || observation.stopReason === 'max_tokens' ||
      (observation.stopReason !== 'tool_use' && observation.stopReason !== 'tool-calls')) return null;
  const calls = observation.nativeContent.filter((block) => block.type === 'tool_use');
  if (calls.length !== 1) return null;
  const call = calls[0]!;
  if (typeof call.id !== 'string' || call.id.length < 1 || call.name !== TOOL.name || !object(call.input) ||
      call.input.topic !== 'Saturn' || Object.keys(call.input).length !== 1) return null;
  return {id:call.id, block:call};
}

function completedJsonChecks(observation: CertificationObservation, expected: Record<string, string | number | boolean>): CaseChecks {
  return {
    completed: observation.outcome === 'completed',
    dispatched: observation.dispatched,
    httpSuccess: observation.httpStatus !== null && observation.httpStatus >= 200 && observation.httpStatus < 300,
    requestHashPresent: observation.requestHash !== null,
    stopReasonAccepted: observation.stopReason === 'end_turn',
    jsonParsedAndExact: parseExactJson(observation.text, expected),
  };
}

function allChecksPass(checks: CaseChecks): boolean { return Object.values(checks).every(Boolean); }

async function invokeCase(args: {
  caseId: CertificationCase;
  journal: CertificationJournal;
  adapter: MiniMaxCertificationAdapter;
  messages: NativeMessage[];
  tools?: NativeTool[];
  thinking: 'disabled' | 'adaptive';
  maxOutputTokens: number;
  runSignal: AbortSignal;
  now: ()=>Date;
}): Promise<CertificationObservation> {
  if (args.runSignal.aborted) throw new Error('Certification run deadline or cancellation reached before quota preflight');
  return args.adapter.invoke({
      messages:args.messages,
      tools:args.tools,
      thinking:args.thinking,
      maxOutputTokens:args.maxOutputTokens,
      deadline:new Date(args.now().getTime() + CERTIFICATION_LIMITS.requestTimeoutMs).toISOString(),
      signal:args.runSignal,
      beforeDispatch:args.journal.beforeDispatch(args.caseId),
    });
}

export async function runMiniMaxCertification(
  checkoutRoot: string,
  apiKey: string,
  dependencies: RunDependencies,
  runSignal = new AbortController().signal,
): Promise<PublicCertificationReport> {
  if (!apiKey.startsWith('sk-cp-')) throw new Error('Live certification requires an sk-cp- subscription key');
  const runController = new AbortController();
  const runTimer = setTimeout(() => runController.abort(new Error('Certification run deadline reached')), CERTIFICATION_LIMITS.runTimeoutMs);
  const boundedSignal = AbortSignal.any([runSignal, runController.signal]);
  try {
  const now = dependencies.now ?? (() => new Date());
  const fetchImpl = dependencies.fetch ?? fetch;
  const journal = await CertificationJournal.create(checkoutRoot, true);
  const adapter = dependencies.createAdapter({apiKey, baseURL:MINIMAX_CERTIFICATION_BASE_URL, fetch:fetchImpl});
  const normalizeRunDeadline = (observation: CertificationObservation): CertificationObservation =>
    observation.outcome === 'aborted' && runController.signal.aborted && !runSignal.aborted
      ? {...observation, outcome:'timeout'}
      : observation;

  await checkMiniMaxQuota(apiKey, fetchImpl, boundedSignal);
  const jsonObservation = normalizeRunDeadline(await invokeCase({
    caseId:'json', journal, adapter, messages:[{role:'user',content:JSON_PROMPT}], thinking:'disabled', maxOutputTokens:512, runSignal:boundedSignal, now,
  }));
  const jsonChecks = {quotaAccepted:true,...completedJsonChecks(jsonObservation, {classification:'certification-ok',count:3})};
  await journal.resolve(jsonObservation, jsonChecks);
  if (!allChecksPass(jsonChecks)) return journal.inspect();

  await checkMiniMaxQuota(apiKey, fetchImpl, boundedSignal);
  const toolObservation = normalizeRunDeadline(await invokeCase({
    caseId:'tool-call', journal, adapter, messages:[{role:'user',content:TOOL_PROMPT}], tools:[TOOL], thinking:'adaptive', maxOutputTokens:2048, runSignal:boundedSignal, now,
  }));
  const toolCall = findToolCall(toolObservation);
  const toolChecks: CaseChecks = {
    quotaAccepted:true,
    completed:toolObservation.outcome === 'completed',
    dispatched:toolObservation.dispatched,
    httpSuccess:toolObservation.httpStatus !== null && toolObservation.httpStatus >= 200 && toolObservation.httpStatus < 300,
    requestHashPresent:toolObservation.requestHash !== null,
    stopReasonIsToolCall:toolObservation.stopReason === 'tool_use' || toolObservation.stopReason === 'tool-calls',
    nativeThinkingReturned:toolObservation.nativeContent.some((block) => block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.length > 0),
    exactToolCall:toolCall !== null,
  };
  await journal.resolve(toolObservation, toolChecks);
  if (!allChecksPass(toolChecks) || !toolCall) return journal.inspect();

  const toolResult = {type:'tool_result',tool_use_id:toolCall.id,content:TOOL_RESULT};
  const continuation: NativeMessage[] = [
    {role:'user',content:TOOL_PROMPT},
    {role:'assistant',content:toolObservation.nativeContent},
    {role:'user',content:[toolResult]},
  ];
  const continuationHasMatchingId = toolResult.tool_use_id === toolCall.id;
  if (!continuationHasMatchingId) return journal.inspect();
  await checkMiniMaxQuota(apiKey, fetchImpl, boundedSignal);
  const continuationObservation = normalizeRunDeadline(await invokeCase({
    caseId:'tool-continuation', journal, adapter, messages:continuation, tools:[TOOL], thinking:'adaptive', maxOutputTokens:2048, runSignal:boundedSignal, now,
  }));
  const continuationChecks = {
    quotaAccepted:true,
    ...completedJsonChecks(continuationObservation, {planet:'Saturn',ringSystem:true}),
    toolResultMatchedCall:continuationHasMatchingId,
  };
  await journal.resolve(continuationObservation, continuationChecks);
  return journal.inspect();
  } finally { clearTimeout(runTimer); }
}

function help(): string {
  return [
    'Usage:',
    '  pnpm exec tsx scripts/certify-minimax.ts --live',
    '  pnpm exec tsx scripts/certify-minimax.ts --inspect artifacts/minimax-certification/<run-uuid>',
    '',
    '--live reads MINIMAX_API_KEY from the current process environment only.',
    'There is no default live mode, endpoint override, retry, resume, or PAYG fallback.',
  ].join('\n');
}

async function cli(): Promise<void> {
  const args = process.argv.slice(2);
  const checkoutRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  if (args[0] === '--inspect' && args.length === 2) {
    console.log(JSON.stringify(await inspectCertificationRun(checkoutRoot, resolve(checkoutRoot, args[1]!)), null, 2));
    return;
  }
  if (args.length !== 1 || args[0] !== '--live') {
    console.error(help());
    process.exitCode = 2;
    return;
  }
  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) throw new Error('MINIMAX_API_KEY is required in the current process environment');
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('Certification interrupted'));
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const report = await runMiniMaxCertification(checkoutRoot, apiKey, {createAdapter:createMiniMaxCertificationAdapter}, controller.signal);
    console.log(JSON.stringify(report, null, 2));
    if (report.attempts.some((attempt) => attempt.status !== 'completed' || !Object.values(attempt.checks).every(Boolean))) process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) cli().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Certification failed');
  process.exitCode = 1;
});
