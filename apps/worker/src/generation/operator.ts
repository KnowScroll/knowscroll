/** ADR-0023 section 6: operator commands. There is no public HTTP route for any of this — it is
 * invoked from a local CLI (`scripts/generation.ts`) by a human operator/coordinator, never by a
 * product client. Every command is a thin, explicit wrapper over `storage.ts`; it adds no new
 * database rules of its own beyond the friendly refusals called out below. */
import {readFile} from 'node:fs/promises';
import type pg from 'pg';
import {generationBrief} from '../../../../packages/contracts/src/generation.ts';
import * as storage from './storage.ts';

export type OperatorResult = {ok: true; value: unknown} | {ok: false; code: string; message: string};

function ok(value: unknown): OperatorResult { return {ok: true, value}; }
function fail(error: unknown): OperatorResult {
  if (error instanceof storage.GenerationDenied) return {ok: false, code: error.code, message: error.message};
  return {ok: false, code: 'unexpected_error', message: error instanceof Error ? error.message : String(error)};
}

export async function registerEngine(db: pg.Pool, args: {origin: string; contractRevision: string; artifactRoot: string; providerMode: 'standin' | 'live'; declaredBy: string}): Promise<OperatorResult> {
  try { return ok(await storage.registerEngine(db, args)); } catch (error) { return fail(error); }
}

export async function retireEngine(db: pg.Pool, engineId: string): Promise<OperatorResult> {
  try { await storage.retireEngine(db, engineId); return ok({retired: true}); } catch (error) { return fail(error); }
}

/** Reads a brief from a JSON file on disk, the way an operator authors one outside the runtime
 * (ADR-0023 section 1: "no model writes it at runtime"). */
export async function addBriefFromFile(db: pg.Pool, path: string, authoredBy: string): Promise<OperatorResult> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'));
    const brief = generationBrief.parse(raw);
    return ok(await storage.addBrief(db, {brief, authoredBy}));
  } catch (error) { return fail(error); }
}

export async function approveBrief(db: pg.Pool, briefId: string): Promise<OperatorResult> {
  try { await storage.approveBrief(db, briefId); return ok({approved: true}); } catch (error) { return fail(error); }
}

export async function createGrant(db: pg.Pool, args: {mode: 'standin' | 'live'; capCents: number; authorizationRef?: string; expiresAt: string}): Promise<OperatorResult> {
  // Friendly, explicit refusal ahead of the database CHECK: a live grant needs a named owner
  // authorization reference, and this runtime slice never assumes one from mode alone.
  if (args.mode === 'live' && (!args.authorizationRef || args.authorizationRef.trim().length === 0)) {
    return {ok: false, code: 'live_grant_requires_authorization', message: 'Refusing to create a live budget grant without an explicit owner authorization reference.'};
  }
  try { return ok(await storage.createGrant(db, args)); } catch (error) { return fail(error); }
}

export async function createJob(db: pg.Pool, args: {briefId: string; engineId: string; grantId: string; until: 'plan' | 'stills' | 'video'; budgetCents: number; deadlineAt: string}): Promise<OperatorResult> {
  try {
    const engine = await storage.engineOrigin(db, args.engineId);
    if (engine?.providerMode === 'live') {
      return {ok: false, code: 'live_dispatch_not_authorized', message: 'No live spend is authorized by this runtime; the owner has not confirmed upstream ships real providers (ADR-0023).'};
    }
    return ok(await storage.createJob(db, args));
  } catch (error) { return fail(error); }
}

export async function requestCancel(db: pg.Pool, jobId: string): Promise<OperatorResult> {
  try { await storage.requestCancel(db, jobId); return ok({cancelRequested: true}); } catch (error) { return fail(error); }
}

export async function jobStatus(db: pg.Pool, jobId: string): Promise<OperatorResult> {
  try {
    const job = await storage.loadJob(db, jobId);
    if (!job) return {ok: false, code: 'unknown_job', message: `No generation job ${jobId}`};
    const attempt = await storage.loadAttempt(db, jobId);
    return ok({job, attempt});
  } catch (error) { return fail(error); }
}
