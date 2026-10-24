import { canonicalJson, type Sha256 } from './fingerprint.js';
import type { ReelBrief, ReelScript, ReelUntil } from './script.js';

/** Cutroom's wire contract version (CF-61). */
const CONTRACT_VERSION = 1;

export interface ReelRequest {
  /** Identity of the script's wire content: no request id, no ceiling, no take (CF-63). */
  readonly scriptSha256: string;
  readonly requestId: string;
  /** The exact bytes sent. They are stored before sending and never rebuilt. */
  readonly requestUtf8: string;
  readonly requestSha256: string;
}

export interface ReelRequestOptions {
  readonly until: ReelUntil;
  /** One order is one take; a new take is a new request id (CF-63). */
  readonly take: number;
  readonly ceilingCents: number;
}

/** The part of the wire body that decides what Cutroom makes, with its keys in a fixed order. */
function content(script: ReelScript, until: ReelUntil) {
  const { brief } = script;
  const criterion = (c: ReelBrief['criteria']['mustShow'][number]) => ({
    id: c.id,
    text: c.text,
    type: c.type,
    ...(c.claimId === undefined ? {} : { claimId: c.claimId }),
  });
  return {
    contractVersion: CONTRACT_VERSION,
    worldId: brief.worldId,
    narration: brief.narration.map((sentence) => ({ text: sentence.text, claimIds: [...sentence.claimIds] })),
    claims: brief.claims.map((claim) => ({ id: claim.id, role: claim.role })),
    criteria: {
      mustShow: brief.criteria.mustShow.map(criterion),
      mustNotShow: brief.criteria.mustNotShow.map(criterion),
      depictionPolicyVersion: brief.criteria.depictionPolicyVersion,
    },
    style: { id: brief.style.id, version: brief.style.version, text: brief.style.text },
    until,
  };
}

/** The digest the pool and the request id are built from; the same in every world. */
export function reelScriptDigest(script: ReelScript, until: ReelUntil, sha256: Sha256): string {
  return sha256(canonicalJson(content(script, until)));
}

export const reelRequestId = (scriptSha256: string, take: number): string =>
  `ks-reel-${scriptSha256.slice(0, 32)}-${take}`;

/**
 * Compiles the wire request once. Claim sources, title and summary stay in KnowScroll: Cutroom
 * receives labels and criteria only (CF-60). Same script, take and ceiling give the same bytes.
 */
export function compileReelRequest(script: ReelScript, options: ReelRequestOptions, sha256: Sha256): ReelRequest {
  const scriptSha256 = reelScriptDigest(script, options.until, sha256);
  const requestId = reelRequestId(scriptSha256, options.take);
  const { contractVersion, worldId, narration, claims, criteria, style } = content(script, options.until);
  const requestUtf8 = JSON.stringify({
    contractVersion,
    requestId,
    worldId,
    narration,
    claims,
    criteria,
    style,
    options: { until: options.until, budgetCents: options.ceilingCents },
  });
  return { scriptSha256, requestId, requestUtf8, requestSha256: sha256(requestUtf8) };
}
