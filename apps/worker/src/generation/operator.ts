/** ADR-0023 section 6: operator commands. There is no public HTTP route for any of this — it is
 * invoked from a local CLI (`scripts/generation.ts`) by a human operator/coordinator, never by a
 * product client. Every command is a thin, explicit wrapper over `storage.ts`; it adds no new
 * database rules of its own beyond the friendly refusals called out below. */
import { readFile } from 'node:fs/promises';
import {
  compileSubmitRequest,
  generationBrief,
} from '@knowscroll/contracts/generation';
import {
  poolRequestId,
  scriptDigest,
} from '@knowscroll/core/cutroom/pool-identity';
import type { PoolLedger } from '@knowscroll/db/pool/ledger';
import type pg from 'pg';
import { prepareCutroomRequest } from '../cutroom/http-client.ts';
import * as storage from './storage.ts';

export type OperatorResult =
  | { ok: true; value: unknown }
  | { ok: false; code: string; message: string };

function ok(value: unknown): OperatorResult {
  return { ok: true, value };
}
function fail(error: unknown): OperatorResult {
  if (error instanceof storage.GenerationDenied)
    return { ok: false, code: error.code, message: error.message };
  return {
    ok: false,
    code: 'unexpected_error',
    message: error instanceof Error ? error.message : String(error),
  };
}

export async function registerEngine(
  db: pg.Pool,
  args: {
    origin: string;
    contractRevision: string;
    artifactRoot: string;
    providerMode: 'standin' | 'live';
    declaredBy: string;
  },
): Promise<OperatorResult> {
  try {
    return ok(await storage.registerEngine(db, args));
  } catch (error) {
    return fail(error);
  }
}

export async function retireEngine(
  db: pg.Pool,
  engineId: string,
): Promise<OperatorResult> {
  try {
    await storage.retireEngine(db, engineId);
    return ok({ retired: true });
  } catch (error) {
    return fail(error);
  }
}

/** Reads a brief from a JSON file on disk, the way an operator authors one outside the runtime
 * (ADR-0023 section 1: "no model writes it at runtime"). */
export async function addBriefFromFile(
  db: pg.Pool,
  path: string,
  authoredBy: string,
): Promise<OperatorResult> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'));
    const brief = generationBrief.parse(raw);
    return ok(await storage.addBrief(db, { brief, authoredBy }));
  } catch (error) {
    return fail(error);
  }
}

export async function approveBrief(
  db: pg.Pool,
  briefId: string,
): Promise<OperatorResult> {
  try {
    await storage.approveBrief(db, briefId);
    return ok({ approved: true });
  } catch (error) {
    return fail(error);
  }
}

export async function createGrant(
  db: pg.Pool,
  args: {
    mode: 'standin' | 'live';
    capCents: number;
    authorizationRef?: string;
    expiresAt: string;
  },
): Promise<OperatorResult> {
  // Friendly, explicit refusal ahead of the database CHECK: a live grant needs a named owner
  // authorization reference, and this runtime slice never assumes one from mode alone.
  if (
    args.mode === 'live' &&
    (!args.authorizationRef || args.authorizationRef.trim().length === 0)
  ) {
    return {
      ok: false,
      code: 'live_grant_requires_authorization',
      message:
        'Refusing to create a live budget grant without an explicit owner authorization reference.',
    };
  }
  try {
    return ok(await storage.createGrant(db, args));
  } catch (error) {
    return fail(error);
  }
}

export async function createJob(
  db: pg.Pool,
  args: {
    briefId: string;
    engineId: string;
    grantId: string;
    until: 'plan' | 'stills' | 'video';
    budgetCents: number;
    deadlineAt: string;
  },
): Promise<OperatorResult> {
  try {
    const engine = await storage.engineOrigin(db, args.engineId);
    if (engine?.providerMode === 'live') {
      return {
        ok: false,
        code: 'live_dispatch_not_authorized',
        message:
          'A live engine is ordered from only through the shared pool: use "order" (#199), which claims the request in the pool and checks the shared $5 first.',
      };
    }
    return ok(await storage.createJob(db, args));
  } catch (error) {
    return fail(error);
  }
}

export async function requestCancel(
  db: pg.Pool,
  jobId: string,
): Promise<OperatorResult> {
  try {
    await storage.requestCancel(db, jobId);
    return ok({ cancelRequested: true });
  } catch (error) {
    return fail(error);
  }
}

export async function jobStatus(
  db: pg.Pool,
  jobId: string,
): Promise<OperatorResult> {
  try {
    const job = await storage.loadJob(db, jobId);
    if (!job)
      return {
        ok: false,
        code: 'unknown_job',
        message: `No generation job ${jobId}`,
      };
    const attempt = await storage.loadAttempt(db, jobId);
    return ok({ job, attempt });
  } catch (error) {
    return fail(error);
  }
}

/** #199: the default ceiling for one paid order, and never more than what is left of the pool. */
const DEFAULT_ORDER_CEILING_CENTS = 75;

/**
 * #199: orders an approved script from the shared pool. The request id is claimed in the pool
 * first, which checks the shared $5 and makes sure no other world has an open (or successful)
 * order of the same script; only then is this world's job created, reserving the same ceiling on
 * this world's own live grant. If another world already ordered the script, nothing is created
 * here: this world receives the Reel once it exists (`syncSharedPool`).
 */
export async function orderShared(
  db: pg.Pool,
  ledger: PoolLedger,
  args: {
    world: string;
    briefId: string;
    grantId: string;
    until: 'plan' | 'stills' | 'video';
    ceilingCents?: number;
    approvalRef: string;
    deadlineAt: string;
    engineId?: string;
  },
): Promise<OperatorResult> {
  try {
    const approved = (await storage.approvedBriefs(db)).find(
      (candidate) => candidate.id === args.briefId,
    );
    if (!approved)
      return {
        ok: false,
        code: 'brief_not_approved',
        message: `No approved brief ${args.briefId} in this world`,
      };
    const engineId =
      args.engineId ?? (await storage.activeLiveEngine(db))?.id ?? null;
    if (engineId === null)
      return {
        ok: false,
        code: 'no_live_engine',
        message: 'This world has no active live engine for the shared pool',
      };
    const budget = await ledger.budget();
    const ceilingCents =
      args.ceilingCents ??
      Math.min(DEFAULT_ORDER_CEILING_CENTS, budget.leftCents);
    if (!Number.isSafeInteger(ceilingCents) || ceilingCents < 1)
      return {
        ok: false,
        code: 'pool_cap_exceeded',
        message: `The shared pool has ${budget.leftCents} cents left of ${budget.capCents}`,
      };

    const digest = scriptDigest(approved.brief, args.until);
    for (let tries = 0; tries < 5; tries += 1) {
      const take = await ledger.nextTake(digest);
      const requestId = poolRequestId(digest, take);
      const bodySha256 = prepareCutroomRequest(
        compileSubmitRequest({
          brief: approved.brief,
          requestId,
          until: args.until,
          budgetCents: ceilingCents,
        }),
      ).bodySha256;
      const claim = await ledger.claim({
        requestId,
        scriptDigest: digest,
        take,
        until: args.until,
        bodySha256,
        world: args.world,
        ceilingCents,
        approvalRef: args.approvalRef,
      });
      if (claim.status === 'take_taken') continue;
      if (claim.status === 'already_ordered')
        return ok({
          ordered: false,
          alreadyOrdered: true,
          requestId: claim.requestId,
          orderedBy: claim.orderedBy,
        });
      if (claim.status === 'cap_exceeded')
        return {
          ok: false,
          code: 'pool_cap_exceeded',
          message: `A ${ceilingCents} cent ceiling does not fit: the shared pool has ${budget.leftCents} cents left of ${budget.capCents}`,
        };
      let created: storage.CreatedJob;
      try {
        created = await storage.createJob(db, {
          briefId: args.briefId,
          engineId,
          grantId: args.grantId,
          until: args.until,
          budgetCents: ceilingCents,
          deadlineAt: args.deadlineAt,
          poolRequestId: requestId,
        });
      } catch (error) {
        await ledger.release(requestId, args.world);
        throw error;
      }
      if (created.bodySha256 !== bodySha256) {
        await storage.requestCancel(db, created.jobId);
        await storage.closeQueuedCancelled(db, created.jobId);
        await ledger.release(requestId, args.world);
        return {
          ok: false,
          code: 'request_bytes_differ',
          message:
            'The stored request differs from the claimed one; the job was cancelled and the claim released',
        };
      }
      return ok({
        ordered: true,
        jobId: created.jobId,
        requestId,
        take,
        ceilingCents,
      });
    }
    return {
      ok: false,
      code: 'pool_take_contention',
      message: 'Could not claim a take after 5 tries',
    };
  } catch (error) {
    return fail(error);
  }
}

/** #199: what the shared pool holds and how much of the $5 is left. */
export async function poolStatus(ledger: PoolLedger): Promise<OperatorResult> {
  try {
    return ok({ budget: await ledger.budget(), orders: await ledger.orders() });
  } catch (error) {
    return fail(error);
  }
}

/** #199: raises (or lowers) this world's own live cap, at most 500 cents by schema. */
export async function setLiveCap(
  db: pg.Pool,
  args: { capCents: number; setBy: string },
): Promise<OperatorResult> {
  try {
    await storage.setLiveCap(db, args);
    return ok({ capCents: args.capCents });
  } catch (error) {
    return fail(error);
  }
}
