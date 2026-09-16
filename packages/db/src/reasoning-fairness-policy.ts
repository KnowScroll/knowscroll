import {createHash} from 'node:crypto';
import {z} from 'zod';
import {ReasoningDenied} from './reasoning-runtime-policy.js';

export const FAIRNESS_CLASSES = ['interactive','active_continuity','accumulated_interpretation','background_inquiry','housekeeping'] as const;
export type FairnessClass = typeof FAIRNESS_CLASSES[number];
export const FAIRNESS_WEIGHTS: Record<FairnessClass, number> = {interactive:5,active_continuity:6,accumulated_interpretation:4,background_inquiry:3,housekeeping:2};
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const policySchema = z.object({
  version:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/),
  quantum:positive, maxCharge:positive, scale:positive,
  basis:z.object({input_tokens:positive,output_tokens:positive,total_tokens:positive,requests:positive}).strict(),
  maxProbes:z.number().int().min(1).max(128),maxAdmissions:z.number().int().min(1).max(16),
}).strict();
export type SqlFairnessPolicy = z.infer<typeof policySchema>;
export function validateFairnessPolicy(input:unknown):{policy:SqlFairnessPolicy;hash:string} {
  const parsed=policySchema.safeParse(input);
  if(!parsed.success) throw new ReasoningDenied('invalid_fairness_policy');
  const policy=parsed.data;
  if(policy.maxCharge>policy.quantum || !Number.isSafeInteger(policy.quantum*6+policy.maxCharge)) throw new ReasoningDenied('invalid_fairness_quantum');
  const canonical={...policy,weights:FAIRNESS_WEIGHTS};
  return {policy,hash:createHash('sha256').update(JSON.stringify(canonical)).digest('hex')};
}
export function fairnessClassCap(policy:SqlFairnessPolicy,lane:FairnessClass):number {
  return policy.quantum*FAIRNESS_WEIGHTS[lane]+policy.maxCharge;
}
export function fairnessUniverseCap(policy:SqlFairnessPolicy):number {return policy.quantum+policy.maxCharge;}
/** Exact dominant-share ceiling; unlike resource dimensions are never added. */
export function fairnessCharge(policy:SqlFairnessPolicy,input:number,output:number,enforceMaximum=true):number {
  if(!Number.isSafeInteger(input)||input<0||!Number.isSafeInteger(output)||output<0||!Number.isSafeInteger(input+output)) throw new ReasoningDenied('invalid_fairness_estimate');
  const demand={input_tokens:input,output_tokens:output,total_tokens:input+output,requests:1};
  let charge=1n;
  for(const key of Object.keys(demand) as Array<keyof typeof demand>) {
    const basis=BigInt(policy.basis[key]);
    const value=(BigInt(policy.scale)*BigInt(demand[key])+basis-1n)/basis;
    if(value>charge) charge=value;
  }
  if(charge>BigInt(Number.MAX_SAFE_INTEGER)) throw new ReasoningDenied('fairness_charge_overflow');
  if(enforceMaximum && charge>BigInt(policy.maxCharge)) throw new ReasoningDenied('impossible_charge');
  return Number(charge);
}
