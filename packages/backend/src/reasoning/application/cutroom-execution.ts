import { z } from 'zod';
import { canTransition, decideOnDelivery } from '../domain/attempts.js';
import type {
  CutroomDispatchPermit,
  CutroomExecutionFoundation,
  CutroomExecutionPorts,
  CutroomIntentRecord,
} from './cutroom-execution-ports.js';
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const ref = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/);
const targetSchema = z.strictObject({
  worldId: z.enum(['dev', 'stage']),
  businessRunId: z.uuid(),
  attemptId: z.uuid(),
});
const observationSchema = z.strictObject({
  requestId: ref,
  runId: ref.nullable(),
  evidenceSha256: digest,
  outcome: z.enum(['pending', 'unknown', 'terminal_unvalidated']),
});
const preflightSchema = z.strictObject({
  attemptId: z.uuid(),
  requestSha256: digest,
  fence: z.number().int().positive().max(2147483647),
  profileSha256: digest,
  soleWriterEvidenceSha256: digest,
  fundsEvidenceSha256: digest,
  observedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  availableCents: z.number().int().min(0).max(900),
  poolReceipt: z.strictObject({
    bindingId: z.uuid(),
    claimedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
    boundAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
  }),
});
const permits = new WeakMap<
  CutroomDispatchPermit,
  { readonly record: CutroomIntentRecord; readonly expires: number }
>();
/** No transport exists in C1. A later transport may consume once; lost COMMIT ACK never returns a permit. */
export function consumeCutroomDispatchPermit(permit: CutroomDispatchPermit): CutroomIntentRecord | undefined {
  const value = permits.get(permit);
  permits.delete(permit);
  return value && Date.now() <= value.expires ? value.record : undefined;
}
export function makeCutroomExecutionFoundation(p: CutroomExecutionPorts): CutroomExecutionFoundation {
  // Registry snapshots cannot acquire authority from subsequent caller mutation.
  const enabled = p.enabled,
    preflights = z.array(preflightSchema).max(16).parse(structuredClone(p.preflights));
  const held = (code: 'disabled' | 'identity' | 'review' | 'preflight' | 'expired' | 'unknown' | 'settled') =>
    ({ kind: 'held', code }) as const;
  return {
    async prepareIntent(authority, attemptId) {
      if (!enabled) return held('disabled');
      if (!z.uuid().safeParse(attemptId).success) return held('identity');
      const result = await p.withScope(authority, 'admit', async (scope) => {
        const identity = await p.store.identify(scope, attemptId);
        if (!identity) return held('identity');
        const decision = decideOnDelivery(identity.state);
        if (decision === 'mark_unknown') {
          const a = await p.store.lock(scope, attemptId);
          if (a && canTransition(a.state, 'unknown')) await p.store.markUnknown(scope, attemptId);
          return held('unknown');
        }
        if (decision !== 'dispatch') return held('settled');
        const review = await p.recheckReview(scope, identity.businessRunId);
        if (!review) return held('review');
        const a = await p.store.lock(scope, attemptId);
        if (!a) return held('identity');
        const currentDecision = decideOnDelivery(a.state);
        if (currentDecision === 'mark_unknown') {
          if (canTransition(a.state, 'unknown')) await p.store.markUnknown(scope, attemptId);
          return held('unknown');
        }
        if (currentDecision !== 'dispatch') return held('settled');
        const matches = preflights.filter(
          (v) => v.attemptId === attemptId && v.requestSha256 === a.requestSha256 && v.fence === a.fence,
        );
        if (matches.length !== 1) return held('preflight');
        const preflight = matches[0]!,
          now = p.now().getTime(),
          observed = Date.parse(preflight.observedAt),
          expires = Date.parse(preflight.expiresAt);
        if (
          observed > now ||
          now - observed > 30000 ||
          expires < now ||
          expires - observed > 30000 ||
          expires <= observed ||
          preflight.availableCents < a.ceilingCents ||
          JSON.stringify(preflight.poolReceipt) !== JSON.stringify(a.poolReceipt)
        )
          return held('preflight');
        if (!canTransition(a.state, 'dispatched')) return held('settled');
        const record = await p.store.intent(scope, attemptId, review, preflight);
        return record ? { kind: 'committed' as const, record, expires } : held('expired');
      });
      if (result.kind !== 'entered') return held('disabled');
      if (result.value.kind !== 'committed') return result.value;
      if (p.now().getTime() > result.value.expires) return held('preflight');
      // withScope has returned only AFTER COMMIT acknowledgement; no callback or out-of-tx send inside it.
      const permit = Object.freeze({}) as CutroomDispatchPermit;
      permits.set(permit, { record: Object.freeze(result.value.record), expires: result.value.expires });
      return { kind: 'prepared', permit };
    },
    async recordObservation(target, input) {
      if (!enabled) return { kind: 'refused', code: 'disabled' };
      const t = targetSchema.safeParse(target),
        o = observationSchema.safeParse(input);
      if (!t.success || !o.success) return { kind: 'refused', code: 'invalid' };
      const r = await p.withAccountingScope(t.data, async (scope) => {
        if (scope.identity.requestId !== o.data.requestId) return { kind: 'refused', code: 'identity' } as const;
        return p.store.observe(scope, o.data);
      });
      return r.kind === 'entered' ? r.value : r;
    },
  };
}
