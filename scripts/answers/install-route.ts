/**
 * #132 — install and enable one answer route in the database named by DATABASE_URL (a disposable
 * one: refused otherwise). KS_ANSWER_TRANSPORT=fixture|minimax, KS_ANSWER_REQUEST_CAP (default 2).
 * Used by the emulator journey runner; the product itself never installs a route implicitly.
 */
import { pool, transaction } from '../../packages/db/src/index.ts';
import { answerAuthority, answerFairnessPolicy, installAskAnswerRoute } from '../../packages/db/src/reasoning-answers.ts';
import { createReasoningFairness } from '../../packages/db/src/reasoning-fairness.ts';

if (!new URL(process.env.DATABASE_URL!).pathname.startsWith('/knowscroll_test_')) throw new Error('Answer routes are installed only in disposable knowscroll_test_* databases');
const transport = process.env.KS_ANSWER_TRANSPORT === 'minimax' ? 'minimax' : 'fixture';
const cap = Number(process.env.KS_ANSWER_REQUEST_CAP ?? 2);
if (!Number.isInteger(cap) || cap < 1 || cap > 40) throw new Error('KS_ANSWER_REQUEST_CAP must be 1..40');
const version = `journey-answers-${transport}-v1`;
await createReasoningFairness(pool, answerAuthority()).installPolicy(answerFairnessPolicy(version, { maxInputTokens: 16384, maxOutputTokens: 1024 }));
await transaction(client => installAskAnswerRoute(client, {
  policyVersion: version, routeId: transport === 'minimax' ? 'minimax-subscription' : 'fixture-route',
  routeProfileVersion: transport === 'minimax' ? 'minimax-m3-anthropic-v1' : 'fixture-v1', transport,
  model: transport === 'minimax' ? 'MiniMax-M3' : 'fixture-model', maxInputTokens: 16384, maxOutputTokens: 1024,
  requestCap: cap, tokenBudget: cap * 20000, ownerCapacity: cap * 20000, jobCapacity: 20000, answerTtlSeconds: 300, remoteSlots: 1,
}));
console.log(JSON.stringify({ route: version, transport, requestCap: cap }));
await pool.end();
