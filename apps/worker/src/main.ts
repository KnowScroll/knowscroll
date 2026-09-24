import { setTimeout } from 'node:timers/promises';
import { pool } from '../../../packages/db/src/index.ts';
import { projectOne } from './project.ts';
import { answerTransportsFromEnvironment } from './reasoning/answer-loop.ts';
import { createReadinessGate, runAnswerPass } from './reasoning/answer-worker.ts';
import { inquiryTransportsFromEnvironment } from './reasoning/inquiry-loop.ts';
import { executeInquiryClaim, runInquiryPass } from './reasoning/inquiry-worker.ts';
import { settleAbandonedAnswers } from '../../../packages/db/src/reasoning-answers.ts';
import { inquiryAuthority, sharedReasoningAuthority } from '../../../packages/db/src/reasoning-inquiries.ts';
import { settleInquiries } from '../../../packages/db/src/reasoning-inquiry-execution.ts';
import { runCorrectionRefreshPass } from '../../../packages/db/src/semantic/correction-refresh.ts';
let running=true;
for(const signal of ['SIGINT','SIGTERM'] as const) process.on(signal,()=>{running=false;});
const workerId=`local-${process.pid}`;
// #132: answers and background inquiries run only when this process was configured with a
// transport for them (ADR-0033 §2, ADR-0038 §2).
const answerTransports=answerTransportsFromEnvironment(process.env);
const inquiryTransports=inquiryTransportsFromEnvironment(process.env,answerTransports);
// Leases on admitted attempts; bounded by admission's own 1..60,000 ms limit.
const leaseMs=(name:string)=>Math.min(60_000,Math.max(1_000,Number(process.env[name] ?? 60_000)||60_000));
const answerLeaseMs=leaseMs('KS_ANSWER_LEASE_MS');
const inquiryLeaseMs=leaseMs('KS_INQUIRY_LEASE_MS');
// Provider readiness (quota) at most every 30 s while work waits; a refusal backs off 60 s. One gate
// per transport instance, so a MiniMax client shared by both paths is asked once per window.
const gates=new Map<object,ReturnType<typeof createReadinessGate>>();
const gatesFor=(transports:Record<string,object|undefined>|null)=>transports?Object.fromEntries(Object.entries(transports).map(([k,t])=>{
 if(!gates.has(t!)) gates.set(t!,createReadinessGate(t as Parameters<typeof createReadinessGate>[0]));
 return [k,gates.get(t!)!];
})):{};
const readiness=gatesFor(answerTransports);
const inquiryReadiness=gatesFor(inquiryTransports);
// ADR-0040: readers behind a source correction are caught up on an interval (at least 1 s), a
// bounded batch (1..100) at a time. Deterministic database work only; no model is called.
const correctionRefreshMs=Math.max(1_000,Number(process.env.KS_CORRECTION_REFRESH_INTERVAL_MS ?? 60_000)||60_000);
const correctionRefreshBatch=Math.min(100,Math.max(1,Math.trunc(Number(process.env.KS_CORRECTION_REFRESH_BATCH ?? 8)||8)));
let lastSweep=0,lastCorrectionRefresh=0,refreshDeferred:string[]=[];
const stop=new AbortController();
for(const signal of ['SIGINT','SIGTERM'] as const) process.on(signal,()=>stop.abort());
console.log(JSON.stringify({service:'worker',workerId,kind:'deterministic-projection',answers:answerTransports?Object.keys(answerTransports):[],inquiries:inquiryTransports?Object.keys(inquiryTransports):[]}));
// A background inquiry the answer route's shared scheduler admits is run by the inquiry path (ADR-0038 §4).
const otherFamily=inquiryTransports?async(scheduled:Parameters<typeof executeInquiryClaim>[1],signal:AbortSignal)=>{
 const route=(await pool.query<{transport:'fixture'|'minimax'}>('SELECT transport FROM background_inquiry_route WHERE enabled')).rows[0];
 const transport=route?inquiryTransports[route.transport]:undefined;
 if(!transport) throw new Error('No inquiry transport for the enabled route');
 const shared=(await pool.query('SELECT 1 FROM ask_answer_route a JOIN background_inquiry_route i ON i.policy_version=a.policy_version WHERE a.enabled AND i.enabled')).rowCount;
 return executeInquiryClaim({pool,owner:workerId,transport,signal,authority:shared?sharedReasoningAuthority():inquiryAuthority()},scheduled);
}:undefined;
try {while(running) {
 await pool.query('INSERT INTO worker_heartbeat(worker_id,last_seen) VALUES($1,now()) ON CONFLICT(worker_id) DO UPDATE SET last_seen=now()',[workerId]);
 try {const result=await projectOne();if(result) console.log(JSON.stringify(result));}
 catch {console.error(JSON.stringify({error:'projection_failed'}));}
 // Minimal logs: ids and outcome kinds only, never a question, a claim, a reply or a key.
 if(answerTransports) {
  try {const pass=await runAnswerPass({pool,owner:workerId,leaseMs:answerLeaseMs,transports:answerTransports,readiness,signal:stop.signal,otherFamily});
   if(pass.kind==='done') console.log(JSON.stringify({answer:pass.askId,invocation:pass.invocation,outcome:pass.outcome.kind,status:'status' in pass.outcome?pass.outcome.status:pass.outcome.reason}));
   if(pass.kind==='other_family') console.log(JSON.stringify({inquiryJob:pass.jobId,via:'answer_scheduler'}));}
  catch {console.error(JSON.stringify({error:'answer_pass_failed'}));}
 }
 if(inquiryTransports) {
  try {const pass=await runInquiryPass({pool,owner:workerId,leaseMs:inquiryLeaseMs,transports:inquiryTransports,readiness:inquiryReadiness,signal:stop.signal,
    answers:answerTransports?{transports:answerTransports,readiness}:undefined});
   if(pass.opened.opened||pass.opened.nothing_to_ask) console.log(JSON.stringify({inquiriesOpened:pass.opened.opened,nothingToAsk:pass.opened.nothing_to_ask}));
   if(pass.kind==='done') console.log(JSON.stringify({inquiry:pass.inquiryId,invocation:pass.invocation,outcome:pass.outcome.kind,
    status:'status' in pass.outcome?pass.outcome.status:'ordinal' in pass.outcome?`step_${pass.outcome.ordinal}_queued`:pass.outcome.reason}));
   if(pass.kind==='answer'&&pass.pass.kind==='done') console.log(JSON.stringify({answer:pass.pass.askId,invocation:pass.pass.invocation,outcome:pass.pass.outcome.kind,via:'inquiry_scheduler'}));}
  catch {console.error(JSON.stringify({error:'inquiry_pass_failed'}));}
 }
 // Work whose worker died is closed once its lease expires (#132 review B2, ADR-0038 §6).
 if((answerTransports||inquiryTransports)&&Date.now()-lastSweep>=5_000) {
  lastSweep=Date.now();
  if(answerTransports) {
   try {const settled=await settleAbandonedAnswers(pool,{owner:workerId});if(settled) console.log(JSON.stringify({answersSettled:settled}));}
   catch {console.error(JSON.stringify({error:'answer_sweep_failed'}));}
  }
  if(inquiryTransports) {
   try {const settled=await settleInquiries(pool,{owner:workerId});if(settled) console.log(JSON.stringify({inquiriesSettled:settled}));}
   catch {console.error(JSON.stringify({error:'inquiry_sweep_failed'}));}
  }
 }
 if(Date.now()-lastCorrectionRefresh>=correctionRefreshMs) {
  lastCorrectionRefresh=Date.now();
  try {const pass=await runCorrectionRefreshPass(pool,{limit:correctionRefreshBatch,deferred:refreshDeferred});
   refreshDeferred=pass.failed.map(f=>f.universeId);
   if(pass.refreshed.length||pass.failed.length) console.log(JSON.stringify({correctionRefresh:pass.refreshed,placeChanges:pass.placeChanges,failed:pass.failed}));}
  catch {console.error(JSON.stringify({error:'correction_refresh_failed'}));}
 }
 await setTimeout(300);
}} finally {await pool.end();}
