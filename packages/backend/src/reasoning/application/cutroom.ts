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
