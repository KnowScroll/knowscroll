/**
 * #132 — the sealed context of one background bridge inquiry (ADR-0038 §5), a separate family
 * routed by `source_policy_version` like the Ask context (ADR-0017). What the model is shown — at
 * most three pairs of the reader's places and the supported claims about them — plus every fact
 * that must still hold at admission, before sending and before applying. Any change is stale.
 */
import { z } from 'zod';
import { conceptCode, semanticKey } from './semantic.ts';
import { reasoningCounter } from './reasoning.ts';

const id = z.string().uuid();
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const label = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/);
const scope = { universeId: id, privacyEpoch: z.number().int().min(0).max(2147483647) };

export const INQUIRY_CONTEXT_VERSIONS = Object.freeze({ compiler: 'bridge-inquiry-context-v1', prompt: 'bridge-inquiry-prompt-v2', sourcePolicy: 'inquiry-bridge-between-places-v1' });
export const INQUIRY_KIND = 'bridge_between_places';
export const INQUIRY_DIRTY_SCOPE = 'inquiry:bridge_between_places';
export const INQUIRY_CONTEXT_LIMITS = Object.freeze({ maxBytes: 65_536, maxDependencies: 128, maxCausesPerInquiry: 16 });

export const inquiryDependency = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('inquiry'), id, ...scope, jobId: id, throughSequence: reasoningCounter }).strict(),
  /** Consent enabled in this epoch, and no request since `sealedAt` turned it off. */
  z.object({ kind: z.literal('consent'), ...scope }).strict(),
  /** Recording not paused, and no pause since `sealedAt`. */
  z.object({ kind: z.literal('recording'), ...scope }).strict(),
  z.object({ kind: z.literal('route'), policyVersion: label }).strict(),
  z.object({ kind: z.literal('place'), id, ...scope, code: conceptCode }).strict(),
  /** Currently supported, with the same statement and source title the model was shown. */
  z.object({ kind: z.literal('claim'), key: semanticKey, hash }).strict(),
  /** Still disconnected (no active relation or admitted bridge either way) and not suppressed. */
  z.object({ kind: z.literal('pair'), from: conceptCode, to: conceptCode }).strict(),
  z.object({ kind: z.literal('runtime_policy'), version: label, hash }).strict(),
]);
export type InquiryDependency = z.infer<typeof inquiryDependency>;
export function inquiryDependencyKey(read: InquiryDependency): string {
  switch (read.kind) {
    case 'inquiry': case 'place': return `${read.kind}:${read.id}`;
    case 'consent': case 'recording': return `${read.kind}:${read.universeId}`;
    case 'route': return `route:${read.policyVersion}`;
    case 'claim': return `claim:${read.key}`;
    case 'pair': return `pair:${read.from}|${read.to}`;
    case 'runtime_policy': return `runtime_policy:${read.version}`;
  }
}

const offeredClaim = z.object({ key: semanticKey, statement: z.string().min(1).max(400), sourceTitle: z.string().min(1).max(300) }).strict();
/** Claims naming both sides also carry each side's role (prompt v2): what "explains" is judged by. */
const namingClaim = offeredClaim.extend({ roles: z.record(z.string(), z.enum(['subject', 'object', 'mechanism'])) }).strict();
const offeredPlace = z.object({ placeId: id, code: conceptCode, name: z.string().min(1).max(80) }).strict();
export const inquiryPair = z.object({
  a: offeredPlace, b: offeredPlace,
  claimsA: z.array(offeredClaim).max(8), claimsB: z.array(offeredClaim).max(8), both: z.array(namingClaim).max(8),
}).strict().refine(p => p.a.code < p.b.code, 'A pair is ordered by concept code');

export const inquiryContextPayload = z.object({
  version: z.literal(1), kind: z.literal('bridge_inquiry_v1'),
  contextId: id, jobId: id, inquiryId: id, ...scope,
  compilerVersion: z.literal(INQUIRY_CONTEXT_VERSIONS.compiler), promptVersion: z.literal(INQUIRY_CONTEXT_VERSIONS.prompt),
  sourcePolicyVersion: z.literal(INQUIRY_CONTEXT_VERSIONS.sourcePolicy),
  runtimePolicyVersion: label, runtimePolicyHash: hash,
  sealedAt: z.iso.datetime({ offset: true }), throughSequence: reasoningCounter,
  pairs: z.array(inquiryPair).min(1).max(3),
  dependencies: z.array(inquiryDependency).min(1).max(INQUIRY_CONTEXT_LIMITS.maxDependencies),
}).strict().superRefine((v, ctx) => {
  const seen = new Set<string>();
  for (const [i, r] of v.dependencies.entries()) {
    const key = inquiryDependencyKey(r);
    if (seen.has(key)) ctx.addIssue({ code: 'custom', path: ['dependencies', i], message: 'Duplicate dependency' });
    seen.add(key);
    if ('universeId' in r && (r.universeId !== v.universeId || r.privacyEpoch !== v.privacyEpoch)) ctx.addIssue({ code: 'custom', path: ['dependencies', i], message: 'Foreign dependency' });
  }
  const expected = [
    `inquiry:${v.inquiryId}`, `consent:${v.universeId}`, `recording:${v.universeId}`, `route:${v.runtimePolicyVersion}`, `runtime_policy:${v.runtimePolicyVersion}`,
    ...v.pairs.flatMap(p => [`place:${p.a.placeId}`, `place:${p.b.placeId}`, `pair:${p.a.code}|${p.b.code}`, ...[...p.claimsA, ...p.claimsB, ...p.both].map(c => `claim:${c.key}`)]),
  ];
  const wanted = new Set(expected);
  if (expected.some(k => !seen.has(k)) || [...seen].some(k => !wanted.has(k))) ctx.addIssue({ code: 'custom', path: ['dependencies'], message: 'Incomplete or extra dependency set' });
});
export type InquiryContextPayload = z.infer<typeof inquiryContextPayload>;
export type InquiryContextRefusal =
  | 'missing' | 'foreign' | 'unsupported' | 'obsolete_epoch' | 'corrupt_seal' | 'changed_policy' | 'bounds_exceeded'
  | 'consent_inactive' | 'recording_paused' | 'route_disabled' | 'inquiry_closed' | 'place_changed' | 'claim_changed' | 'pair_connected';
