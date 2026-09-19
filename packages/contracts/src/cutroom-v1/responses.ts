import { z } from 'zod'
import { RunEvent } from './events.ts'
import { ContractVersion } from './version.ts'

// Every answer to a submit, a status or an events request, and every way a run can finish.

export const SubmitResponse = z.union([
  z.strictObject({
    contractVersion: ContractVersion,
    outcome: z.literal('accepted'),
    requestId: z.string().min(1),
    runId: z.string().min(1),
    replayed: z.boolean(),
  }),
  z.strictObject({
    contractVersion: ContractVersion,
    outcome: z.literal('refused'),
    /** A malformed body may have no requestId at all. */
    requestId: z.string().min(1).optional(),
    reason: z.enum(['version', 'invalid', 'conflict', 'unsupported']),
    detail: z.string(),
  }),
])

export const RunStatus = z.strictObject({
  contractVersion: ContractVersion,
  runId: z.string().min(1),
  requestId: z.string().min(1),
  state: z.enum(['running', 'finished']),
  lastSeq: z.number().int().nonnegative(),
})

export const EventsPage = z
  .strictObject({
    contractVersion: ContractVersion,
    runId: z.string().min(1),
    events: z.array(RunEvent),
    /** The last returned event's seq, or the `since` that was asked for if none were returned. */
    nextSince: z.number().int().nonnegative(),
  })
  .superRefine((page, ctx) => {
    page.events.forEach((event, i) => {
      if (event.contractVersion !== page.contractVersion) {
        ctx.addIssue({
          code: 'custom',
          path: ['events', i, 'contractVersion'],
          message: 'an event carries a different contractVersion from its page (D-106)',
        })
      }
    })
  })

/** A picture, returned as an absolute path on the engine's machine — never as bytes. */
export const StillRef = z.strictObject({
  pictureId: z.string().min(1),
  shotId: z.string().min(1),
  path: z.string().min(1),
})

/** One progressive MP4 with narration and captions, and no sources card (D-056, D-101). */
export const VideoRef = z.strictObject({ path: z.string().min(1) })

export const Degradation = z.strictObject({
  shotId: z.string().min(1),
  reason: z.string().min(1),
})

/** Every budget answer carries all four figures (D-097, D-100). */
const budgetFigures = {
  limit: z.enum(['reel', 'ceiling']),
  estimateCents: z.number().int().nonnegative(),
  ceilingCents: z.number().int().positive(),
  capCents: z.number().int().positive(),
}

const finished = {
  contractVersion: ContractVersion,
  runId: z.string().min(1),
  requestId: z.string().min(1),
  /** Generation spend only; planning is not generation, so a plan-only run costs 0. */
  costCents: z.number().int().nonnegative(),
}

const estimateCents = z.number().int().nonnegative()

export const RunResult = z.union([
  z.strictObject({
    ...finished,
    status: z.literal('completed'),
    until: z.literal('plan'),
    estimateCents,
  }),
  z.strictObject({
    ...finished,
    status: z.literal('completed'),
    until: z.literal('stills'),
    estimateCents,
    stills: z.array(StillRef),
    degradations: z.array(Degradation),
  }),
  z.strictObject({
    ...finished,
    status: z.literal('completed'),
    until: z.literal('video'),
    estimateCents,
    stills: z.array(StillRef),
    video: VideoRef,
    degradations: z.array(Degradation),
  }),
  z.strictObject({
    ...finished,
    status: z.literal('refused'),
    reason: z.literal('budget'),
    ...budgetFigures,
  }),
  z.strictObject({
    ...finished,
    status: z.literal('stopped'),
    reason: z.literal('budget'),
    ...budgetFigures,
  }),
  z.strictObject({
    ...finished,
    status: z.literal('stopped'),
    reason: z.literal('rule'),
    rule: z.string().min(1),
    step: z.string().min(1),
    detail: z.string(),
  }),
  z.strictObject({ ...finished, status: z.literal('failed'), detail: z.string() }),
  z.strictObject({ ...finished, status: z.literal('cancelled') }),
])

export type SubmitResponse = z.infer<typeof SubmitResponse>
export type RunStatus = z.infer<typeof RunStatus>
export type EventsPage = z.infer<typeof EventsPage>
export type StillRef = z.infer<typeof StillRef>
export type VideoRef = z.infer<typeof VideoRef>
export type Degradation = z.infer<typeof Degradation>
export type RunResult = z.infer<typeof RunResult>
