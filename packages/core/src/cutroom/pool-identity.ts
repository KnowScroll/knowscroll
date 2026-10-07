/**
 * #199: the identity of a script in the shared Reel pool. Two worlds holding the same approved
 * script compute the same digest, because it covers exactly what crosses the wire to Cutroom
 * (narration, claims, criteria, style, stage, variation) and nothing world-local: no database id,
 * no request id and no ceiling. A pool request id is the digest's first 32 hex digits plus the
 * take, so ordering the same script again after a failed run is a new request, never a replay.
 */
import { createHash } from 'node:crypto';
import {
  compileSubmitRequest,
  type GenerationBrief,
} from '@knowscroll/contracts/generation';

type Stage = 'plan' | 'stills' | 'video';

const POOL_REQUEST_ID = /^ks-reel-([0-9a-f]{32})-([1-9][0-9]{0,2})$/;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The digest of what this script sends to Cutroom at `until`, independent of who sends it. */
export function scriptDigest(brief: GenerationBrief, until: Stage): string {
  const compiled = compileSubmitRequest({
    brief,
    requestId: 'pool-digest',
    until,
    budgetCents: 1,
  }) as {
    requestId?: unknown;
    options: { budgetCents?: unknown } & Record<string, unknown>;
  } & Record<string, unknown>;
  const { requestId: _requestId, options, ...rest } = compiled;
  const { budgetCents: _budgetCents, ...stage } = options;
  return createHash('sha256')
    .update(canonical({ ...rest, options: stage }))
    .digest('hex');
}

export function poolRequestId(digest: string, take: number): string {
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error('Invalid script digest');
  if (!Number.isSafeInteger(take) || take < 1 || take > 999)
    throw new Error('Invalid pool take');
  return `ks-reel-${digest.slice(0, 32)}-${take}`;
}

export function isPoolRequestId(value: string): boolean {
  return POOL_REQUEST_ID.test(value);
}
