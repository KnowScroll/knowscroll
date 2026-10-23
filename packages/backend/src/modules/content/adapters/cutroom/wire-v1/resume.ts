import { z } from 'zod'
import { ContractVersion } from './version.ts'

// Asking the engine to make a failed run again, keeping every piece already checked
// (docs/features/resume-failed.md, Gate 2 "What the caller sees"; S-161, S-162). Version 1, amended
// as a criterion's type amended it (S-034): no caller exists for a bump to protect. Every object is
// strict; the request and every answer carry the version, and a piece, nested, does not (D-106).

/**
 * One piece a caller names not to keep: a shot's still, narration or clip — or, with no shot, that
 * piece of every shot that has one (S-161). A shot is named as the record names it, `shot-<n>`.
 */
export const Piece = z.strictObject({
  kind: z.enum(['still', 'narration', 'clip']),
  shot: z
    .string()
    .regex(/^shot-(0|[1-9]\d*)$/, 'a shot is named shot-<n>, as the record names it')
    .optional(),
})

/**
 * `POST /v1/runs/:runId/resume`. `remake` names the pieces made again; absent or empty keeps every
 * piece the run checked. `preview: true` answers what the resume would make and cost, and spends
 * and writes nothing — D-095's free estimate, for a resume.
 */
export const ResumeRequest = z.strictObject({
  contractVersion: ContractVersion,
  remake: z.array(Piece).optional(),
  preview: z.literal(true).optional(),
})

const runId = z.string().min(1)
const cents = z.number().int().nonnegative()
const limit = z.enum(['reel', 'ceiling'])

/**
 * The figures a resume is admitted on (D-097, D-100). `estimateCents` is, as everywhere in this
 * contract, the figure compared with the limit: what the reel has spent — the failed run and the run
 * it resumes — plus what the resume would make. The resume's own cost is `estimateCents −
 * spentCents`.
 */
const figures = {
  estimateCents: cents,
  spentCents: cents,
  capCents: z.number().int().positive(),
  ceilingCents: z.number().int().positive(),
}

export const ResumeResponse = z.union([
  /** 200: what the resume would make again, in shot order, and what it would cost. */
  z.strictObject({
    contractVersion: ContractVersion,
    outcome: z.literal('preview'),
    runId,
    remake: z.array(Piece),
    ...figures,
    /** Present when the resume would pass a limit, and which. */
    limit: limit.optional(),
  }),
  /**
   * 202: the new run, `runId`, which resumes the failed one. `replayed` is true when the failed run
   * was resumed already with this list — its pieces in any order, or named twice (S-162).
   */
  z.strictObject({
    contractVersion: ContractVersion,
    outcome: z.literal('accepted'),
    runId,
    resumes: runId,
    replayed: z.boolean(),
  }),
  /**
   * 409 `not-resumable` or `resumed` — the latter naming the run that resumed it; 422 `version`,
   * `invalid` or `unsupported`. `runId` is the run the route was called on.
   */
  z.strictObject({
    contractVersion: ContractVersion,
    outcome: z.literal('refused'),
    runId,
    reason: z.enum(['not-resumable', 'resumed', 'version', 'invalid', 'unsupported']),
    detail: z.string(),
  }),
  /** 409: the resume would pass the per-reel cap or the caller's ceiling. No run is made. */
  z.strictObject({
    contractVersion: ContractVersion,
    outcome: z.literal('refused'),
    runId,
    reason: z.literal('budget'),
    limit,
    ...figures,
  }),
])

export type Piece = z.infer<typeof Piece>
export type ResumeRequest = z.infer<typeof ResumeRequest>
export type ResumeResponse = z.infer<typeof ResumeResponse>
