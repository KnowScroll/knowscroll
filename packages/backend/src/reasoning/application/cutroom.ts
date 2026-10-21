import { z } from 'zod';
import { canTransitionCutroomAttempt, decideCutroomDelivery } from '../domain/cutroom-attempt.js';
import type {
  CutroomB,
  CutroomBPorts,
  CutroomBResult,
  CutroomCandidate,
  CutroomOwnerApproval,
  CutroomScopeTx,
  CutroomAuthority,
  CutroomAttemptRecord,
  CutroomPoolOperation,
  CutroomPoolObservation,
  CutroomNotSent,
  CutroomPoolIdentity,
  CutroomPoolReceipt,
} from './cutroom-ports.js';
import type {
  CutroomAttemptIdentity,
  CutroomAttemptSnapshot,
  CutroomCentsReceipt,
  CutroomCentsReservation,
  CutroomDispatchOutcome,
  CutroomProtectedRequest,
} from '../domain/cutroom-attempt.js';

// No constructor/exported symbol: a parsed ref, environment value or model output is not authority.
declare const verifiedOwnerCapability: unique symbol;
export interface CutroomOwnerCapability {
  readonly [verifiedOwnerCapability]: true;
  readonly businessRunId: string;
  readonly scriptSha256: string;
  readonly requestSha256: string;
  readonly approvalRef: string;
}

/**
 * Future worker-only execution boundary. DECLARATION ONLY: no binding, implementation or grant.
 * Reasoning owns protected requests, dispatch intent and attempts; Content owns the business run.
 * The implementation must reverify capability, live fal balance, <=75c Reel and <=200c v2 grant,
 * and the actual pool claim before committing intent. Pool/world writes are not one transaction.
 * Lost commit acknowledgement stops dispatch; later deliveries consult the SAME attempt.
 * HTTP refusal/conflict alone cannot clear original unknown liability, release its pool claim,
 * prove zero charge or authorize another POST/new attempt; reconcile the original identity.
 * No caller-resume POST is admitted by this seam. Engine auto-resumes are observations only.
 */
export interface CutroomExecution {
  reserve(
    input: {
      readonly identity: CutroomAttemptIdentity;
      readonly protectedRequest: CutroomProtectedRequest;
      readonly ceilingCents: number;
    },
    capability: CutroomOwnerCapability,
  ): Promise<
    CutroomCentsReservation | { readonly kind: 'refused'; readonly code: 'authority' | 'budget' | 'preflight' }
  >;
  readAttempt(identity: CutroomAttemptIdentity): Promise<CutroomAttemptSnapshot | undefined>;
  dispatch(reservation: CutroomCentsReservation, capability: CutroomOwnerCapability): Promise<CutroomDispatchOutcome>;
  /** Reconcile the original identity; neither ready=true nor lookup 404 permits another POST. */
  reconcile(identity: CutroomAttemptIdentity): Promise<CutroomCentsReceipt>;
}

// B is deliberately separate from the future complete CutroomExecution above.
// A trusted registry is composition-owned data, never proof recovered from a caller's JSON.

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const approvalSchema = z.strictObject({
  businessRunId: z.uuid(),
  generation: z.number().int().positive().max(2147483647),
  worldId: z.enum(['dev', 'stage']),
  scriptSha256: digest,
  evidenceSha256: digest,
  requestSha256: digest,
  requestId: z.string().max(100),
  take: z.number().int().min(1).max(999),
  until: z.literal('video'),
  ceilingCents: z.number().int().min(1).max(75),
  grantRef: z.literal('knowscroll-v2-d018'),
  approvalRef: z.string().min(1).max(128),
  principalOid: z
    .string()
    .regex(/^[1-9][0-9]{0,9}$/)
    .refine((v) => BigInt(v) <= 4294967295n),
  principalName: z.string().min(1).max(63),
  policyVersion: z.literal('cutroom-commission.v1'),
});
const candidateSchema = approvalSchema.extend({
  requestUtf8: z.string().min(1).max(100000),
  byteLength: z.number().int().min(1).max(100000),
  contractVersion: z.literal(1),
});
function approvalOf(c: CutroomCandidate): CutroomOwnerApproval {
  return approvalSchema.parse({
    businessRunId: c.businessRunId,
    generation: c.generation,
    worldId: c.worldId,
    scriptSha256: c.scriptSha256,
    evidenceSha256: c.evidenceSha256,
    requestSha256: c.requestSha256,
    requestId: c.requestId,
    take: c.take,
    until: c.until,
    ceilingCents: c.ceilingCents,
    grantRef: c.grantRef,
    approvalRef: c.approvalRef,
    principalOid: c.principalOid,
    principalName: c.principalName,
    policyVersion: c.policyVersion,
  });
}
const summary = (a: CutroomAttemptRecord): CutroomBResult => ({
  kind: 'pending',
  attemptId: a.attemptId,
  state: a.state,
  poolState: a.poolState,
});
const held = (code: 'identity' | 'expired' | 'pending' | 'unknown' | 'needs_operator'): CutroomBResult => ({
  kind: 'held',
  code,
});
const permits = new WeakMap<
  CutroomNotSent,
  {
    readonly operationId: string;
    readonly fence: number;
    readonly identity: string;
    readonly receipt: CutroomPoolReceipt;
  }
>();
const identityKey = (i: CutroomPoolIdentity) =>
  JSON.stringify([
    i.grantRef,
    i.requestId,
    i.scriptSha256,
    i.take,
    i.until,
    i.requestSha256,
    i.worldId,
    i.ceilingCents,
    i.approvalRef,
    i.principalOid,
    i.principalName,
  ]);
/** Internal adapter check, not a public mint function. Deserialized/forged capabilities fail. */
export function consumeCutroomNotSent(
  proof: CutroomNotSent,
  operation: CutroomPoolOperation,
  identity: CutroomPoolIdentity,
): CutroomPoolReceipt | undefined {
  const p = permits.get(proof);
  permits.delete(proof);
  return p &&
    p.operationId === operation.operationId &&
    p.fence === operation.fence &&
    p.identity === identityKey(identity) &&
    operation.kind === 'release'
    ? p.receipt
    : undefined;
}
export function makeCutroomB(p: CutroomBPorts): CutroomB {
  // Snapshot caller-owned configuration; subsequent mutation cannot add owner approvals.
  const approvals = p.approvals.map((value) => Object.freeze(approvalSchema.parse(value)));
  const admitted = (scope: CutroomScopeTx, input: CutroomCandidate): boolean => {
    if (!p.enabled || scope.mode !== 'admit' || !scope.enabled) return false;
    const parsed = candidateSchema.safeParse(input);
    if (!parsed.success) return false;
    const c = parsed.data;
    return (
      c.worldId === scope.authority.worldId &&
      c.generation === scope.authority.generation &&
      c.requestId === `ks-reel-${c.scriptSha256.slice(0, 32)}-${c.take}` &&
      p.byteLength(c.requestUtf8) === c.byteLength &&
      p.sha256(c.requestUtf8) === c.requestSha256 &&
      approvals.some((a) => JSON.stringify(a) === JSON.stringify(approvalOf(c)))
    );
  };
  async function locked(scope: CutroomScopeTx, id: string) {
    if (!z.uuid().safeParse(id).success) return undefined;
    const business = await p.ledger.identify(scope, id);
    if (!business || !(await p.lockBusiness(scope, business))) return undefined;
    return p.ledger.find(scope, id);
  }
  async function inScope(
    authority: CutroomAuthority,
    mode: 'admit' | 'recover',
    work: (scope: CutroomScopeTx) => Promise<CutroomBResult>,
  ): Promise<CutroomBResult> {
    const result = await p.withScope(authority, mode, work);
    return result.kind === 'entered' ? result.value : { kind: 'refused', code: result.code };
  }
  async function after(
    authority: CutroomAuthority,
    prior: CutroomAttemptRecord,
    operation: CutroomPoolOperation,
    observation: CutroomPoolObservation,
  ): Promise<CutroomBResult> {
    return inScope(authority, 'recover', async (scope) => {
      const current = await locked(scope, prior.attemptId);
      if (!current || current.fence !== prior.fence) return held('pending');
      const checked: CutroomPoolObservation =
        observation.kind === 'exact' &&
        ((current.poolReceipt !== null &&
          JSON.stringify(current.poolReceipt) !== JSON.stringify(observation.receipt)) ||
          (observation.state === 'released' && (current.state !== 'not_sent' || current.dispatchIntentAt !== null)))
          ? { kind: 'held', reason: 'needs_operator' }
          : observation;
      await p.ledger.observe(scope, current, operation, checked);
      return checked.kind === 'held'
        ? held(checked.reason === 'needs_operator' ? 'needs_operator' : 'unknown')
        : summary((await p.ledger.find(scope, current.attemptId))!);
    });
  }
  return {
    withScope: p.withScope,
    admitted,
    async reserve(scope, input) {
      const parsed = candidateSchema.safeParse(input);
      if (!parsed.success) return { kind: 'refused', code: 'invalid' };
      const candidate = Object.freeze(parsed.data);
      if (!admitted(scope, candidate)) return { kind: 'refused', code: 'authority' };
      if (!(await p.lockBusiness(scope, candidate.businessRunId))) return { kind: 'refused', code: 'authority' };
      const old = await p.ledger.findBusiness(scope, candidate.businessRunId);
      if (old) {
        const { byteLength, contractVersion, ...prior } = old.candidate;
        if (
          JSON.stringify(approvalSchema.parse(prior)) !== JSON.stringify(approvalOf(candidate)) ||
          byteLength !== candidate.byteLength ||
          contractVersion !== candidate.contractVersion
        )
          return held('identity');
        if (!(await p.ledger.request(scope, old))) return held('expired');
        return summary(old);
      }
      return summary(await p.ledger.reserve(scope, candidate));
    },
    async readScoped(scope, id) {
      const a = await locked(scope, id);
      return !a ? held('identity') : a.purged ? held('expired') : summary(a);
    },
    read: (authority, id) =>
      inScope(authority, 'recover', async (scope) => {
        const a = await locked(scope, id);
        return a ? summary(a) : held('identity');
      }),
    async claim(authority, id) {
      // Intent and required job are acknowledged BEFORE connecting to the separate pool.
      const prepared = await p.withScope(authority, 'admit', async (scope) => {
        const a = await locked(scope, id);
        if (!a) return held('identity');
        if (decideCutroomDelivery(a.state) !== 'dispatch' || a.dispatchIntentAt !== null) return held('pending');
        const bytes = await p.ledger.request(scope, a);
        if (!bytes) return held('expired');
        const candidate = { ...a.candidate, requestUtf8: bytes };
        if (!admitted(scope, candidate)) return { kind: 'refused', code: 'authority' } as const;
        const operation = await p.ledger.operation(scope, a, 'claim');
        if (!operation || operation.state !== 'pending') return held('pending');
        await p.ledger.start(scope, operation);
        return { a, operation };
      });
      if (prepared.kind === 'refused') return { kind: 'refused', code: prepared.code };
      if ('kind' in prepared.value) return prepared.value;
      const { a, operation } = prepared.value;
      let result: CutroomPoolObservation;
      try {
        result = await p.pool.claim(a.candidate);
      } catch {
        result = { kind: 'held', reason: 'unknown' };
      }
      return after(authority, a, operation, result);
    },
    async reconcile(authority, id) {
      const prepared = await p.withScope(authority, 'recover', async (scope) => {
        const a = await locked(scope, id);
        if (!a) return undefined;
        const operation =
          (await p.ledger.operation(scope, a, 'release')) ?? (await p.ledger.operation(scope, a, 'claim'));
        return operation ? { a, operation } : undefined;
      });
      if (prepared.kind === 'refused') return { kind: 'refused', code: prepared.code };
      if (!prepared.value) return held('identity');
      const { a, operation } = prepared.value;
      let result: CutroomPoolObservation;
      try {
        result = await p.pool.read(a.candidate);
      } catch {
        result = { kind: 'held', reason: 'unknown' };
      }
      return after(authority, a, operation, result);
    },
    cancel: (authority, id) =>
      inScope(authority, 'recover', async (scope) => {
        const a = await locked(scope, id);
        if (!a) return held('identity');
        if (a.dispatchIntentAt !== null || !canTransitionCutroomAttempt(a.state, 'not_sent')) return held('pending');
        return summary(await p.ledger.cancel(scope, a));
      }),
    async releaseNotSent(authority, id) {
      const prepared = await p.withScope(authority, 'recover', async (scope) => {
        const a = await locked(scope, id);
        if (!a || a.state !== 'not_sent' || a.dispatchIntentAt !== null || !a.poolReceipt || a.poolState !== 'claimed')
          return undefined;
        const claim = await p.ledger.operation(scope, a, 'claim');
        if (!claim || claim.state !== 'confirmed') return undefined;
        const prior = await p.ledger.operation(scope, a, 'release');
        if (prior && prior.fence !== a.fence) return undefined;
        const operation = prior ?? (await p.ledger.releaseIntent(scope, a));
        await p.ledger.start(scope, operation);
        return { a, operation };
      });
      if (prepared.kind === 'refused') return { kind: 'refused', code: prepared.code };
      if (!prepared.value) return held('pending');
      const { a, operation } = prepared.value;
      // This line is unreachable on lost world COMMIT acknowledgement. No serializable permit exists.
      const proof = Object.freeze({}) as CutroomNotSent;
      permits.set(proof, {
        operationId: operation.operationId,
        fence: operation.fence,
        identity: identityKey(a.candidate),
        receipt: a.poolReceipt!,
      });
      let result: CutroomPoolObservation;
      try {
        result = await p.pool.release(a.candidate, operation, proof);
      } catch {
        result = { kind: 'held', reason: 'needs_operator' };
      } finally {
        permits.delete(proof);
      }
      return after(authority, a, operation, result);
    },
    async purge(authority, limit = 50) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('CUTROOM_PURGE_BOUND');
      const result = await p.withScope(authority, 'recover', async (scope) => {
        let count = 0;
        for (const row of await p.ledger.expired(scope, limit)) {
          if (!(await p.lockBusiness(scope, row.businessRunId))) continue;
          const a = await p.ledger.find(scope, row.attemptId);
          if (!a) continue;
          const current =
            a.state === 'reserved' && a.dispatchIntentAt === null && canTransitionCutroomAttempt(a.state, 'not_sent')
              ? await p.ledger.cancel(scope, a)
              : a;
          await p.ledger.purge(scope, current);
          count++;
        }
        return count;
      });
      return result.kind === 'entered' ? result.value : 0;
    },
  };
}
