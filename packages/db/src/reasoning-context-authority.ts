import {DIRECT_CONTEXT_VERSIONS} from '../../contracts/src/reasoning-context.ts';
import {ASK_CONTEXT_VERSIONS} from '../../contracts/src/reasoning-ask-context.ts';
import {INQUIRY_CONTEXT_VERSIONS} from '../../contracts/src/reasoning-inquiry-context.ts';
import {validateDirectContext} from './reasoning-context.ts';
import {validateDirectAskContext} from './reasoning-ask-context.ts';
import {validateInquiryContext} from './reasoning-inquiry-context.ts';
import {ReasoningDenied,type ReasoningAuthority} from './reasoning-runtime-policy.ts';

/** Explicit immutable metadata routing; never guess a family from JSON shape.
 * This remains an internal authority adapter, not a product execution consumer.
 */
export function createSealedContextAuthority(resolvePolicy:ReasoningAuthority['resolvePolicy']):ReasoningAuthority {
 return {resolvePolicy,async validateContext(client,scope,phase){
  const row=(await client.query<{source_policy_version:string}>(`SELECT source_policy_version FROM reasoning_context
   WHERE id=$1 AND job_id=$2 AND universe_id=$3 AND privacy_epoch=$4`,
   [scope.contextId,scope.jobId,scope.universeId,scope.privacyEpoch])).rows[0];
  if(!row)throw new ReasoningDenied('context_missing');
  const validator=row.source_policy_version===DIRECT_CONTEXT_VERSIONS.sourcePolicy?validateDirectContext:
   row.source_policy_version===ASK_CONTEXT_VERSIONS.sourcePolicy?validateDirectAskContext:
   row.source_policy_version===INQUIRY_CONTEXT_VERSIONS.sourcePolicy?validateInquiryContext:null;
  if(!validator)throw new ReasoningDenied('context_unsupported');
  const result=await validator(client,scope,resolvePolicy,phase);
  if(!result.valid)throw new ReasoningDenied(`context_${result.reason}`);
  return true;
 }};
}
