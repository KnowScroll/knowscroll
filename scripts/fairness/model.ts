import {createHash} from 'node:crypto';

/**
 * Pure, deterministic fairness model for issue #54.  It is deliberately not a
 * scheduler or an admission authority: callers supply already-authorized work
 * and model physical capacity as explicit events.
 */
export const CLASSES = ['interactive', 'active_continuity', 'accumulated_interpretation', 'background_inquiry', 'housekeeping'] as const;
export type FairnessClass = typeof CLASSES[number];
export type DimensionKind = 'budget' | 'rate' | 'remote';
export type NormalizedKind = 'tokens' | 'requests';
export type ReservationStatus = 'reserved' | 'consumed' | 'not_sent' | 'unknown' | 'terminal';

export type NormalizedDimension = {key: string; kind: NormalizedKind; basis: number};
export type PhysicalDimension = {key: string; kind: DimensionKind; capacity: number};
export type FairnessPolicy = {
  version: string; quantum: number; maxNormalizedRequest: number; scale: number;
  maxReadySetSize: number; maxScanPerTick: number; maxAdmissionsPerTick: number;
  normalized: readonly NormalizedDimension[]; physical: readonly PhysicalDimension[];
  weights: Record<FairnessClass, number>;
};
export type Candidate = {attemptId: string; reservationId: string; universeId: string; class: FairnessClass; enqueue: number; demand: Record<string, number>; basisVersion: string; notBefore?: number; deadline?: number; blocked?: boolean};
export type Receipt = {receiptId: string; actual: Record<string, number>; terminal?: boolean; outcome?: 'consumed' | 'not_sent' | 'unknown' | 'terminal'};
export type Reservation = Candidate & {charge: number; settledCharge: number; status: ReservationStatus; demand: Record<string, number>; actual: Record<string, number>; receiptFingerprints: Record<string, string>; frozen: boolean; rateReleased: boolean};
export type Lane = {credit: number; cursor: number};
export type OpenVisit = {class: FairnessClass; remaining: number; universeId: string | null; universeRemaining: number};
export type FairnessSnapshot = {
  policyVersion: string; classCursor: number; classLanes: Record<FairnessClass, Lane>;
  universeLanes: Record<string, Lane>; ready: Candidate[]; reservations: Record<string, Reservation>;
  pausedDimensions: string[]; openVisit: OpenVisit | null; visitGeneration: number; trace: Decision[];
};
export type Decision = {kind: 'admitted' | 'blocked' | 'impossible' | 'idle' | 'settled' | 'frozen' | 'deadline_missed'; attemptId?: string; reason?: string; charge?: number; class?: FairnessClass; universeId?: string; visitGeneration?: number};
export type TickResult = {snapshot: FairnessSnapshot; decisions: Decision[]};

const MAX=Number.MAX_SAFE_INTEGER;
function validInt(n: unknown, positive=false): n is number { return typeof n==='number' && Number.isSafeInteger(n) && (positive?n>0:n>=0); }
function assertSafe(n: unknown, name: string, positive=false): number { if(!validInt(n,positive)) throw new Error(`invalid_${name}`); return n; }
function add(a:number,b:number):number { const n=a+b;if(!Number.isSafeInteger(n)) throw new Error('integer_overflow');return n; }
function sub(a:number,b:number):number { const n=a-b;if(!Number.isSafeInteger(n)) throw new Error('integer_overflow');return n; }
function cap(value:number, ceiling:number):number { return Math.min(value,ceiling); }
function canonical(value: unknown): string {
  if(value===null || typeof value!=='object') return JSON.stringify(value);
  if(Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value as Record<string,unknown>).sort().map(k=>`${JSON.stringify(k)}:${canonical((value as Record<string,unknown>)[k])}`).join(',')}}`;
}
function clone<T>(value:T):T { return JSON.parse(JSON.stringify(value)) as T; }
function classRing(_policy:FairnessPolicy):FairnessClass[] { return [...CLASSES]; }
function classCap(policy:FairnessPolicy, c:FairnessClass):number { return add(policy.weights[c]*policy.quantum,policy.maxNormalizedRequest); }
function universeCap(policy:FairnessPolicy):number { return add(policy.quantum,policy.maxNormalizedRequest); }
function universeKey(c:FairnessClass,id:string):string { return `${c}:${id}`; }
function physical(policy:FairnessPolicy,key:string):PhysicalDimension { const d=policy.physical.find(x=>x.key===key);if(!d) throw new Error(`unknown_dimension:${key}`);return d; }
function hasPositiveCredit(lane:Lane):void { if(lane.credit>0) lane.credit=0; }

export function validatePolicy(policy:FairnessPolicy):void {
  assertSafe(policy.quantum,'quantum',true);assertSafe(policy.maxNormalizedRequest,'max_normalized_request',true);assertSafe(policy.scale,'scale',true);
  assertSafe(policy.maxReadySetSize,'max_ready_set_size',true);assertSafe(policy.maxScanPerTick,'max_scan_per_tick',true);assertSafe(policy.maxAdmissionsPerTick,'admission_limit',true);
  if(policy.maxNormalizedRequest>policy.quantum) throw new Error('max_request_exceeds_quantum');
  if(new Set(policy.normalized.map(d=>d.key)).size!==policy.normalized.length || !policy.normalized.some(d=>d.kind==='requests')) throw new Error('invalid_normalized_dimensions');
  for(const d of policy.normalized) { assertSafe(d.basis,`basis:${d.key}`,true); }
  if(new Set(policy.physical.map(d=>d.key)).size!==policy.physical.length) throw new Error('duplicate_physical_dimension');
  for(const d of policy.physical) assertSafe(d.capacity,`capacity:${d.key}`,true);
  for(const c of CLASSES) assertSafe(policy.weights[c],`weight:${c}`,true);
}
export function createSnapshot(policy:FairnessPolicy):FairnessSnapshot {
  validatePolicy(policy);
  const classLanes=Object.fromEntries(CLASSES.map(c=>[c,{credit:0,cursor:0}])) as Record<FairnessClass,Lane>;
  return {policyVersion:policy.version,classCursor:0,classLanes,universeLanes:{},ready:[],reservations:{},pausedDimensions:[],openVisit:null,visitGeneration:0,trace:[]};
}
export function normalizedCharge(policy:FairnessPolicy,demand:Record<string,number>, enforceMaximum=true):number {
  validatePolicy(policy); let dominant=0;
  for(const d of policy.normalized) {
    const value=assertSafe(demand[d.key],`demand:${d.key}`,d.kind==='requests');
    // Exact integer ceiling; BigInt avoids unsafe multiplication before division.
    const numerator=BigInt(policy.scale)*BigInt(value), denominator=BigInt(d.basis);
    const share=Number((numerator+denominator-1n)/denominator);
    if(!Number.isSafeInteger(share)) throw new Error('normalized_charge_overflow');
    dominant=Math.max(dominant,share);
  }
  dominant=Math.max(1,dominant);if(enforceMaximum&&dominant>policy.maxNormalizedRequest) throw new Error('permanently_impossible_charge');
  return dominant;
}
function validateDemand(policy:FairnessPolicy,demand:Record<string,number>):void {
  for(const d of policy.physical) assertSafe(demand[d.key],`physical_demand:${d.key}`,d.kind==='remote');
  // Queue discovery records impossible work as an observable decision; only admission rejects it.
  normalizedCharge(policy,demand,false);
}
export function enqueue(policy:FairnessPolicy,snapshot:FairnessSnapshot,candidate:Candidate):FairnessSnapshot {
  const state=clone(snapshot);validatePolicy(policy);validateDemand(policy,candidate.demand);
  if(state.ready.length>=policy.maxReadySetSize) throw new Error('ready_set_bound');
  if(state.ready.some(x=>x.attemptId===candidate.attemptId)||state.reservations[candidate.attemptId]) throw new Error('duplicate_attempt');
  if(!CLASSES.includes(candidate.class)||!candidate.attemptId||!candidate.reservationId||!candidate.universeId||!candidate.basisVersion) throw new Error('invalid_candidate');
  assertSafe(candidate.enqueue,'enqueue');state.ready.push(clone(candidate));
  state.ready.sort((a,b)=>a.class.localeCompare(b.class)||a.universeId.localeCompare(b.universeId)||a.enqueue-b.enqueue||a.attemptId.localeCompare(b.attemptId));
  state.universeLanes[universeKey(candidate.class,candidate.universeId)]??={credit:0,cursor:0};return state;
}
function heldFor(policy:FairnessPolicy,r:Reservation,d:PhysicalDimension):number {
  if(r.status==='not_sent') return 0;
  if(d.kind==='remote') return r.status==='terminal'?0:r.demand[d.key]!;
  if(d.kind==='rate') return r.rateReleased?0:Math.max(r.demand[d.key]!,r.actual[d.key]??0);
  return r.actual[d.key]??r.demand[d.key]!;
}
function available(policy:FairnessPolicy,state:FairnessSnapshot,demand:Record<string,number>):string|null {
  if(state.pausedDimensions.length) return 'policy_paused';
  for(const d of policy.physical) {
    const used=Object.values(state.reservations).reduce((total,r)=>add(total,heldFor(policy,r,d)),0);
    if(add(used,demand[d.key]!)>d.capacity) return `capacity:${d.key}`;
  }
  return null;
}
function readyForClass(state:FairnessSnapshot,c:FairnessClass):Candidate[] { return state.ready.filter(x=>x.class===c); }
function nextCandidate(policy:FairnessPolicy,state:FairnessSnapshot,c:FairnessClass,scan:{remaining:number}, onlyUniverse:string|null=null):{candidate:Candidate|null; reason:string|null; impossible:Candidate|null} {
  const candidates=readyForClass(state,c);if(!candidates.length) return {candidate:null,reason:'empty',impossible:null};
  const universes=(onlyUniverse?[onlyUniverse]:[...new Set(candidates.map(x=>x.universeId))].sort()); const lane=state.classLanes[c];
  let blocked:string|null=null;
  for(let i=0;i<universes.length && scan.remaining>0;i++) {
    const index=onlyUniverse?0:lane.cursor%universes.length, universe=universes[index]!;scan.remaining-=1;lane.cursor=(index+1)%universes.length;
    const inUniverse=candidates.filter(x=>x.universeId===universe).sort((a,b)=>a.enqueue-b.enqueue||a.attemptId.localeCompare(b.attemptId));
    if(!inUniverse.length) return {candidate:null,reason:'empty',impossible:null};
    const ul=state.universeLanes[universeKey(c,universe)]!;
    const candidate=inUniverse[ul.cursor%inUniverse.length]!;ul.cursor=(ul.cursor+1)%inUniverse.length;
    if(candidate.blocked) { blocked??='scope_blocked';continue; }
    try { normalizedCharge(policy,candidate.demand); } catch(error) { return {candidate:null,reason:null,impossible:candidate}; }
    for(const d of policy.physical) if(candidate.demand[d.key]!>d.capacity) return {candidate:null,reason:null,impossible:candidate};
    const capacity=available(policy,state,candidate.demand);if(capacity===null) return {candidate,reason:null,impossible:null};blocked??=capacity;
  }
  return {candidate:null,reason:scan.remaining===0?'scan_bound':blocked??'blocked',impossible:null};
}
function append(state:FairnessSnapshot,d:Decision,decisions:Decision[]):void { state.trace.push(d);decisions.push(d); }
function removeReady(state:FairnessSnapshot,attemptId:string):Candidate { const index=state.ready.findIndex(x=>x.attemptId===attemptId);if(index<0) throw new Error('missing_ready_attempt');return state.ready.splice(index,1)[0]!; }
function admit(policy:FairnessPolicy,state:FairnessSnapshot,candidate:Candidate,decisions:Decision[]):boolean {
  const charge=normalizedCharge(policy,candidate.demand), cl=state.classLanes[candidate.class], ul=state.universeLanes[universeKey(candidate.class,candidate.universeId)]!;
  const visit=state.openVisit!;
  if(charge>cl.credit||charge>ul.credit||charge>visit.remaining||charge>visit.universeRemaining) return false;
  cl.credit=sub(cl.credit,charge);ul.credit=sub(ul.credit,charge);visit.remaining=sub(visit.remaining,charge);visit.universeRemaining=sub(visit.universeRemaining,charge);
  removeReady(state,candidate.attemptId);
  state.reservations[candidate.attemptId]={...candidate,charge,settledCharge:charge,status:'reserved',demand:clone(candidate.demand),actual:{},receiptFingerprints:{},frozen:false,rateReleased:false};
  append(state,{kind:'admitted',attemptId:candidate.attemptId,charge,class:candidate.class,universeId:candidate.universeId,visitGeneration:state.visitGeneration},decisions);return true;
}
/** Runs finite scheduling work.  A later tick resumes the exact class visit without re-minting it. */
export type ScheduleLimits = Partial<Pick<FairnessPolicy,'maxScanPerTick'|'maxAdmissionsPerTick'>> & {now?: number};
export function scheduleTick(policy:FairnessPolicy,snapshot:FairnessSnapshot,limits:ScheduleLimits={}):TickResult {
  const state=clone(snapshot),decisions:Decision[]=[];validatePolicy(policy);
  if(state.policyVersion!==policy.version) throw new Error('policy_version_mismatch');
  let scan={remaining:limits.maxScanPerTick??policy.maxScanPerTick}, admissions=limits.maxAdmissionsPerTick??policy.maxAdmissionsPerTick;
  assertSafe(scan.remaining,'scan_limit',true);assertSafe(admissions,'admission_limit',true);
  const ring=classRing(policy);let spins=0;
  while(scan.remaining>0&&admissions>0&&state.ready.length&&spins<ring.length*2) {
    let c:FairnessClass;
    if(state.openVisit) c=state.openVisit.class;
    else { c=ring[state.classCursor]!;state.classCursor=(state.classCursor+1)%ring.length; }
    const found=nextCandidate(policy,state,c,scan,state.openVisit?.universeId??null);
    if(found.impossible) { removeReady(state,found.impossible.attemptId);append(state,{kind:'impossible',attemptId:found.impossible.attemptId,reason:'normalized_charge'},decisions);spins=0;continue; }
    if(!found.candidate) {
      if(!state.openVisit) hasPositiveCredit(state.classLanes[c]);
      else if(state.openVisit.universeId!==null) { state.openVisit.universeId=null;state.openVisit.universeRemaining=0; }
      else state.openVisit=null;
      append(state,{kind:'idle',reason:found.reason??'empty'},decisions);spins+=1;continue;
    }
    const candidate=found.candidate;
    if(candidate.deadline!==undefined && limits.now!==undefined && candidate.deadline<=limits.now) {
      removeReady(state,candidate.attemptId);append(state,{kind:'deadline_missed',attemptId:candidate.attemptId,class:candidate.class,universeId:candidate.universeId,reason:'deadline'},decisions);state.openVisit=null;spins=0;continue;
    }
    if(candidate.notBefore!==undefined && limits.now!==undefined && candidate.notBefore>limits.now) {
      append(state,{kind:'blocked',attemptId:candidate.attemptId,class:candidate.class,universeId:candidate.universeId,reason:'not_before'},decisions);state.openVisit=null;spins+=1;continue;
    }
    const classLane=state.classLanes[candidate.class], universeLane=state.universeLanes[universeKey(candidate.class,candidate.universeId)]!;
    if(!state.openVisit) {
      classLane.credit=cap(add(classLane.credit,policy.weights[candidate.class]*policy.quantum),classCap(policy,candidate.class));
      state.visitGeneration=add(state.visitGeneration,1);state.openVisit={class:candidate.class,remaining:classCap(policy,candidate.class),universeId:null,universeRemaining:0};
    }
    // A universe receives one q quantum on each visit, independently capped; refunds cannot enlarge this visit.
    if(state.openVisit.universeId!==candidate.universeId) {
      universeLane.credit=cap(add(universeLane.credit,policy.quantum),universeCap(policy));
      state.openVisit.universeId=candidate.universeId;
      state.openVisit.universeRemaining=universeCap(policy);
    }
    if(admit(policy,state,candidate,decisions)) { admissions-=1;spins=0;continue; }
    // DRR keeps the visit open for future accumulated credit, but rotates away from this unaffordable head now.
    append(state,{kind:'blocked',attemptId:candidate.attemptId,reason:'deficit'},decisions);
    if(state.openVisit.remaining<normalizedCharge(policy,candidate.demand) || classLane.credit<normalizedCharge(policy,candidate.demand)) state.openVisit=null;
    else { state.openVisit.universeId=null;state.openVisit.universeRemaining=0; }
    spins+=1;
  }
  return {snapshot:state,decisions};
}
function recomputeCharge(policy:FairnessPolicy,r:Reservation):number {
  const demand={...r.demand};for(const d of policy.normalized) if(r.actual[d.key]!==undefined) demand[d.key]=r.actual[d.key]!;
  return normalizedCharge(policy,demand,false);
}
/** Authenticated cumulative receipt abstraction. Exact duplicate receipt IDs are no-ops; conflicts freeze. */
export function settle(policy:FairnessPolicy,snapshot:FairnessSnapshot,attemptId:string,receipt:Receipt):TickResult {
  const state=clone(snapshot), decisions:Decision[]=[];validatePolicy(policy);const r=state.reservations[attemptId];
  if(!r) throw new Error('unknown_attempt');if(r.frozen) return {snapshot:state,decisions};
  if(!state.universeLanes[universeKey(r.class,r.universeId)]) throw new Error('missing_retained_lane');
  const fingerprint=canonical({actual:receipt.actual,terminal:receipt.terminal??false,outcome:receipt.outcome??null});
  const prior=r.receiptFingerprints[receipt.receiptId];
  if(prior) { if(prior!==fingerprint) {r.frozen=true;append(state,{kind:'frozen',attemptId,reason:'conflicting_receipt'},decisions);} return {snapshot:state,decisions}; }
  if(receipt.outcome==='not_sent' && r.status!=='reserved') { r.frozen=true;append(state,{kind:'frozen',attemptId,reason:'not_sent_after_possible_dispatch'},decisions);return {snapshot:state,decisions}; }
  if(receipt.outcome==='unknown' && r.status==='terminal') { r.frozen=true;append(state,{kind:'frozen',attemptId,reason:'terminal_regression'},decisions);return {snapshot:state,decisions}; }
  const known=new Set([...policy.physical,...policy.normalized].map(d=>d.key));
  for(const [key,value] of Object.entries(receipt.actual)) { if(!known.has(key)) throw new Error(`unknown_actual_dimension:${key}`);assertSafe(value,`actual:${key}`);if(value<(r.actual[key]??0)) {r.frozen=true;append(state,{kind:'frozen',attemptId,reason:'decreasing_receipt'},decisions);return {snapshot:state,decisions};} }
  r.receiptFingerprints[receipt.receiptId]=fingerprint;Object.assign(r.actual,clone(receipt.actual));
  const next=receipt.outcome==='not_sent'?0:recomputeCharge(policy,r),delta=sub(r.settledCharge,next), cl=state.classLanes[r.class],ul=state.universeLanes[universeKey(r.class,r.universeId)]!;
  // Refunds are capped; overage is deliberately allowed to form negative debt.
  cl.credit=delta>=0?cap(add(cl.credit,delta),classCap(policy,r.class)):add(cl.credit,delta);
  ul.credit=delta>=0?cap(add(ul.credit,delta),universeCap(policy)):add(ul.credit,delta);r.settledCharge=next;
  if(receipt.outcome) r.status=receipt.outcome;
  if(receipt.terminal) r.status='terminal';
  for(const d of policy.physical) if((r.actual[d.key]??0)>r.demand[d.key]! || heldFor(policy,r,d)>d.capacity) state.pausedDimensions=[...new Set([...state.pausedDimensions,d.key])].sort();
  append(state,{kind:'settled',attemptId,charge:next},decisions);return {snapshot:state,decisions};
}
/** Rate-window renewal only clears rate charges; it never releases budget or remote holds. */
export function rolloverRateWindow(policy:FairnessPolicy,snapshot:FairnessSnapshot):FairnessSnapshot {
  const state=clone(snapshot);for(const r of Object.values(state.reservations)) r.rateReleased=policy.physical.some(d=>d.kind==='rate');
  return state;
}
export function snapshotHash(snapshot:FairnessSnapshot):string { return createHash('sha256').update(canonical(snapshot)).digest('hex'); }
