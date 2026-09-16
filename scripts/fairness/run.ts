import {createHash} from 'node:crypto';
import {createSnapshot, enqueue, scheduleTick, snapshotHash, type Candidate} from './model.ts';
import {candidate, fixturePolicy, runScenario} from './scenarios.ts';

const policy=fixturePolicy({physical:[
 {key:'budget',kind:'budget',capacity:100_000}, {key:'rate',kind:'rate',capacity:100_000}, {key:'remote',kind:'remote',capacity:100},
]});
type Case={name:string;work:Candidate[];now?:number};
const work=(klass:Candidate['class'],count:number,prefix:string,tokens=100)=>Array.from({length:count},(_,i)=>candidate(`${prefix}${i}`,`u-${i%4}`,klass,tokens));
const cases:Case[]=[
 {name:'steady-load',work:work('interactive',40,'steady-',25)},
 {name:'saturated-classes',work:[...work('interactive',12,'i'),...work('active_continuity',12,'a'),...work('accumulated_interpretation',12,'c'),...work('background_inquiry',12,'b'),...work('housekeeping',12,'h')]},
 {name:'large-versus-sparse-universes',work:[candidate('large','large','interactive',100),...work('interactive',8,'sparse-',25)]},
 {name:'borrow-and-return',work:[candidate('borrow','u-i','interactive'),candidate('return','u-h','housekeeping')]},
 {name:'idle-credit-cap',work:[candidate('idle','u','interactive',100)]},
 {name:'maximum-request',work:[candidate('maximum','u','interactive',100)]},
 {name:'permanently-impossible',work:[{...candidate('impossible','u','interactive',101),demand:{tokens:101,requests:1,budget:101,rate:101,remote:1}}]},
 {name:'unknown-hold',work:[candidate('unknown','u','interactive'),candidate('later','v','interactive')]},
 {name:'estimate-error',work:[candidate('estimate','u','interactive',100)]},
 {name:'restart-replay-deadline',work:[{...candidate('late','u','interactive'),deadline:10}],now:20},
];
function summary(name:string, state:ReturnType<typeof createSnapshot>, decisions:ReturnType<typeof scheduleTick>['decisions']) {
 const byClass:Record<string,number>={},byUniverse:Record<string,number>={};
 for(const d of decisions.filter(d=>d.kind==='admitted')) {if(d.class)byClass[d.class]=(byClass[d.class]??0)+1;if(d.universeId)byUniverse[d.universeId]=(byUniverse[d.universeId]??0)+1;}
 return {name,snapshotHash:snapshotHash(state),visitGeneration:state.visitGeneration,admissionsByClass:byClass,admissionsByUniverse:byUniverse,outcomes:decisions.map(({kind,reason,attemptId,visitGeneration})=>({kind,reason,attemptId,visitGeneration}))};
}
const traces=cases.map(item=>{let state=createSnapshot(policy);for(const c of item.work)state=enqueue(policy,state,c);const result=scheduleTick(policy,state,{now:item.now,maxAdmissionsPerTick:64,maxScanPerTick:64});return summary(item.name,result.snapshot,result.decisions);});
console.log(JSON.stringify({model:'bounded-two-level-drr-v1',policyVersion:policy.version,policySha256:createHash('sha256').update(JSON.stringify(policy)).digest('hex'),policy:{quantum:policy.quantum,maxNormalizedRequest:policy.maxNormalizedRequest,weights:policy.weights,maxScanPerTick:policy.maxScanPerTick,maxAdmissionsPerTick:policy.maxAdmissionsPerTick},traces},null,2));
